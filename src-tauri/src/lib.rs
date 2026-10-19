use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{Datelike, Duration, Local, NaiveDate};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

static WATCHERS: Mutex<Vec<RecommendedWatcher>> = Mutex::new(Vec::new());
static INITIAL_VAULT: Mutex<Option<String>> = Mutex::new(None);

/// 递归收集仓库内 .md、views/*.yml 与常用办公文档（跳过 .git 等隐藏目录/文件）
fn collect_md(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    const DOC_EXTS: [&str; 7] = ["docx", "xlsx", "pptx", "pdf", "doc", "xls", "ppt"];
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_md(root, &path, out);
        } else {
            let lower = name.to_lowercase();
            let ext = lower.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
            let rel = path.strip_prefix(root).ok().map(|r| r.to_string_lossy().replace('\\', "/"));
            if let Some(rel) = rel {
                if lower.ends_with(".md")
                    || (lower.ends_with(".yml") && rel.starts_with("views/"))
                    || DOC_EXTS.contains(&ext)
                {
                    out.push(rel);
                }
            }
        }
    }
}

fn safe_join(root: &str, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim_start_matches(['/', '\\']);
    if rel.split(['/', '\\']).any(|seg| seg == "..") {
        return Err("invalid path".into());
    }
    Ok(PathBuf::from(root).join(rel))
}

// 注意：命令函数不能加 pub —— 多 crate 类型(staticlib/cdylib/rlib)下
// pub 命令会触发 E0255（__cmd__ 宏重复定义），见 tauri#15921
#[tauri::command]
fn vault_list(root: String) -> Result<Vec<String>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err("not a directory".into());
    }
    let mut out = Vec::new();
    collect_md(&root_path, &root_path, &mut out);
    out.sort();
    Ok(out)
}

/// 拖放分流用：区分文件与文件夹（有扩展名的文件夹也会误判，必须查文件系统）
#[tauri::command]
fn path_is_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[tauri::command]
fn vault_read(root: String, rel: String) -> Result<String, String> {
    fs::read_to_string(safe_join(&root, &rel)?).map_err(|e| e.to_string())
}

#[tauri::command]
fn vault_write(root: String, rel: String, content: String) -> Result<(), String> {
    let path = safe_join(&root, &rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn vault_delete(root: String, rel: String) -> Result<(), String> {
    fs::remove_file(safe_join(&root, &rel)?).map_err(|e| e.to_string())
}

/// 仓库根目录改名：把仓库所在的磁盘文件夹整体改名，返回新路径
#[tauri::command]
fn vault_rename_root(root: String, new_name: String) -> Result<String, String> {
    let name = new_name.trim();
    if name.is_empty() || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("名称非法".into());
    }
    let src = PathBuf::from(&root);
    if !src.is_dir() {
        return Err("仓库目录不存在".into());
    }
    let parent = src.parent().ok_or("无法取得上级目录")?;
    let dst = parent.join(name);
    if dst == src {
        return Ok(src.to_string_lossy().to_string());
    }
    if dst.exists() {
        return Err("目标位置已存在同名文件或文件夹".into());
    }
    fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

/// 目录改名/移动（仅限仓库内同层改名用；目标已存在则拒绝）
#[tauri::command]
fn vault_rename_dir(root: String, from: String, to: String) -> Result<(), String> {
    if to.trim_matches(['/', '\\']).is_empty() {
        return Err("目标目录为空".into());
    }
    let src = safe_join(&root, &from)?;
    let dst = safe_join(&root, &to)?;
    if !src.is_dir() {
        return Err("目录不存在".into());
    }
    if dst.exists() {
        return Err("目标位置已存在同名文件或文件夹".into());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(src, dst).map_err(|e| e.to_string())
}

/// 递归删除目录（含子目录与其中全部文件，不可恢复）
#[tauri::command]
fn vault_delete_dir(root: String, rel: String) -> Result<(), String> {
    if rel.trim_matches(['/', '\\']).is_empty() {
        return Err("拒绝删除仓库根目录".into());
    }
    let path = safe_join(&root, &rel)?;
    if !path.is_dir() {
        return Err("目录不存在".into());
    }
    fs::remove_dir_all(path).map_err(|e| e.to_string())
}

/// 附件二进制读写（base64）
#[tauri::command]
fn vault_write_bin(root: String, rel: String, b64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| e.to_string())?;
    let path = safe_join(&root, &rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn vault_read_bin(root: String, rel: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = fs::read(safe_join(&root, &rel)?).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// 监听仓库文件夹变更，向前端发射 `vault-fs-event` { rel, kind }
/// 监听仓库文件夹变更（支持多个仓库同时监听），向前端发射 `vault-fs-event` { root, rel, kind }
#[tauri::command]
fn vault_watch(app: AppHandle, root: String) -> Result<(), String> {
    let root_norm = root.trim_end_matches(['/', '\\']).replace('\\', "/");
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

    let mut watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    watcher
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    {
        let mut slot = WATCHERS.lock().map_err(|e| e.to_string())?;
        slot.push(watcher); // 每个仓库一个 watcher，会话期间共存
    }

    std::thread::spawn(move || {
        for ev in rx {
            let Ok(ev) = ev else { continue };
            let kind = match ev.kind {
                EventKind::Create(_) => "create",
                EventKind::Remove(_) => "remove",
                _ => "write",
            };
            for p in &ev.paths {
                let s = p.to_string_lossy().replace('\\', "/");
                let Some(rel) = s.strip_prefix(&root_norm) else { continue };
                let rel = rel.trim_start_matches('/').to_string();
                if rel.is_empty() {
                    continue;
                }
                let _ = app.emit(
                    "vault-fs-event",
                    serde_json::json!({ "root": root_norm, "rel": rel, "kind": kind }),
                );
            }
        }
    });
    Ok(())
}

/* ==================== tantivy 全文索引 ====================
 * 中文按 2-gram 分词（自实现分词器 + LowerCaser），BM25 排序；
 * 每仓库一个内存索引，按 mtime（毫秒）增量同步（增/改/删），外部编辑即时可见。
 * 单字符查询无法产生 bigram，回退到实时扫描。
 */
use std::collections::HashMap;
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, Occur, PhraseQuery, Query, TermQuery};
use tantivy::schema::{Field, IndexRecordOption, NumericOptions, Schema, TextFieldIndexing, TextOptions, Value as DocValue, STRING};
use tantivy::tokenizer::{LowerCaser, TextAnalyzer, Token, TokenStream, Tokenizer};
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, Term};

/// 滑动双字分词器。自实现原因：自带的 NgramTokenizer 产出 token 的 position 恒为 0，
/// PhraseQuery（位置连续匹配）永远无法命中；这里 position 逐字符递增，
/// 于是「查询词 bigram 序列的短语匹配」精确等价于「子串匹配」，中英文通吃。
#[derive(Clone, Default)]
struct CjkBigramTokenizer;

struct CjkBigramStream<'a> {
    text: &'a str,
    starts: Vec<usize>, // 每个字符起始字节偏移，末尾附 text.len()
    k: usize,           // 当前窗口的字符下标
    token: Token,
}

impl Tokenizer for CjkBigramTokenizer {
    type TokenStream<'a> = CjkBigramStream<'a>;
    fn token_stream<'a>(&'a mut self, text: &'a str) -> CjkBigramStream<'a> {
        let mut starts = vec![0usize];
        for (_, c) in text.char_indices() {
            starts.push(starts.last().unwrap() + c.len_utf8());
        }
        CjkBigramStream { text, starts, k: 0, token: Token::default() }
    }
}

impl TokenStream for CjkBigramStream<'_> {
    fn advance(&mut self) -> bool {
        if self.k + 2 >= self.starts.len() {
            return false;
        }
        let from = self.starts[self.k];
        let to = self.starts[self.k + 2];
        self.token.position = self.k;
        self.token.offset_from = from;
        self.token.offset_to = to;
        self.token.text.clear();
        self.token.text.push_str(&self.text[from..to]);
        self.k += 1;
        true
    }
    fn token(&self) -> &Token {
        &self.token
    }
    fn token_mut(&mut self) -> &mut Token {
        &mut self.token
    }
}

struct VaultIndex {
    writer: IndexWriter,
    reader: IndexReader,
    f_rel: Field,
    f_title: Field,
    f_body: Field,
    seen: HashMap<String, u64>, // rel -> 建索引时的 mtime（毫秒）
}

static INDEXES: Mutex<Option<HashMap<String, VaultIndex>>> = Mutex::new(None);

fn create_index() -> tantivy::Result<VaultIndex> {
    let cjk_indexing = || {
        TextOptions::default()
            .set_indexing_options(
                TextFieldIndexing::default()
                    .set_tokenizer("cjk")
                    .set_index_option(IndexRecordOption::WithFreqsAndPositions),
            )
            .set_stored()
    };
    let mut builder = Schema::builder();
    let f_rel = builder.add_text_field("rel", STRING.set_stored());
    let f_title = builder.add_text_field("title", cjk_indexing());
    let f_body = builder.add_text_field("body", cjk_indexing());
    builder.add_u64_field("mtime", NumericOptions::default().set_stored());
    let schema = builder.build();

    let index = Index::create_in_ram(schema);
    index.tokenizers().register(
        "cjk",
        TextAnalyzer::builder(CjkBigramTokenizer).filter(LowerCaser).build(),
    );
    let writer = index.writer(50_000_000)?;
    let reader = index.reader_builder().reload_policy(ReloadPolicy::Manual).try_into()?;
    Ok(VaultIndex { writer, reader, f_rel, f_title, f_body, seen: HashMap::new() })
}

/// 对比磁盘现状增量更新索引（删掉消失的文件、重读 mtime 变化的文件）
fn sync_index(root: &str, idx: &mut VaultIndex) -> Result<(), String> {
    let mut now: HashMap<String, u64> = HashMap::new();
    for rel in vault_files(root) {
        if let Ok(path) = safe_join(root, &rel) {
            now.insert(rel, mtime_ms(&path));
        }
    }
    let mut changed = false;
    let stale: Vec<String> = idx.seen.keys().filter(|r| !now.contains_key(*r)).cloned().collect();
    for rel in stale {
        idx.writer.delete_term(Term::from_field_text(idx.f_rel, &rel));
        idx.seen.remove(&rel);
        changed = true;
    }
    for (rel, mtime) in &now {
        if idx.seen.get(rel) == Some(mtime) {
            continue;
        }
        let Ok(text) = fs::read_to_string(safe_join(root, rel)?) else { continue };
        idx.writer.delete_term(Term::from_field_text(idx.f_rel, rel)); // upsert
        let d = doc! {
            idx.f_rel => rel.as_str(),
            idx.f_title => note_title(rel, &text),
            idx.f_body => text.as_str(),
        };
        idx.writer.add_document(d).map_err(|e| e.to_string())?;
        idx.seen.insert(rel.clone(), *mtime);
        changed = true;
    }
    if changed {
        idx.writer.commit().map_err(|e| e.to_string())?;
        idx.reader.reload().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 一个词的 bigram 序列恰好是原串的逐位滑动窗口，
/// PhraseQuery（零位移）等价于子串匹配，中英文通吃
fn word_query(field: Field, word: &str) -> Box<dyn Query> {
    let chars: Vec<char> = word.chars().collect();
    let terms: Vec<Term> = chars
        .windows(2)
        .map(|w| Term::from_field_text(field, &w.iter().collect::<String>()))
        .collect();
    if terms.len() == 1 {
        Box::new(TermQuery::new(terms[0].clone(), IndexRecordOption::Basic))
    } else {
        Box::new(PhraseQuery::new(terms))
    }
}

/// 命中处前后片段（对齐 UTF-8 字符边界）
fn snippet_around(text: &str, needle: &str) -> String {
    let Some(idx) = text.to_lowercase().find(&needle.to_lowercase()) else {
        return text.chars().take(100).collect();
    };
    let bytes = text.as_bytes();
    let mut start = idx.saturating_sub(40);
    while start < bytes.len() && (bytes[start] & 0xC0) == 0x80 {
        start += 1;
    }
    let mut end = (idx + needle.len() + 60).min(bytes.len());
    // end 必须落在字符首字节上：bytes[end] 是续字节说明 end 在字符中间，回退
    while end > start && end < bytes.len() && (bytes[end] & 0xC0) == 0x80 {
        end -= 1;
    }
    text[start..end].replace('\n', " ")
}

/// 索引搜索：词内 bigram 短语匹配 + 词间 AND；短词（单字符）回退扫描
fn indexed_search(root: &str, query: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
    let tokens: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    if tokens.is_empty() {
        return Ok(Vec::new());
    }
    if tokens.iter().any(|t| t.chars().count() < 2) {
        return scan_search(root, &tokens.join(" "), limit);
    }
    let mut indexes = INDEXES.lock().map_err(|e| e.to_string())?;
    let key = root.trim_end_matches(['/', '\\']).to_string();
    let map = indexes.get_or_insert_with(HashMap::new);
    if !map.contains_key(&key) {
        let created = create_index().map_err(|e| e.to_string())?;
        map.insert(key.clone(), created);
    }
    let idx = map.get_mut(&key).expect("just inserted");
    sync_index(root, idx)?;
    let mut musts: Vec<(Occur, Box<dyn Query>)> = Vec::new();
    for w in &tokens {
        let per_field = BooleanQuery::new(vec![
            (Occur::Should, word_query(idx.f_title, w)),
            (Occur::Should, word_query(idx.f_body, w)),
        ]);
        musts.push((Occur::Must, Box::new(per_field)));
    }
    let q = BooleanQuery::new(musts);
    let searcher = idx.reader.searcher();
    let top = searcher
        .search(&q, &TopDocs::with_limit(limit))
        .map_err(|e| e.to_string())?;
    let mut hits = Vec::new();
    for (_score, addr) in top {
        let Ok(d) = searcher.doc::<tantivy::TantivyDocument>(addr) else { continue };
        let (Some(rel), Some(body)) = (
            d.get_first(idx.f_rel).and_then(|v| v.as_str()),
            d.get_first(idx.f_body).and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        let title = d.get_first(idx.f_title).and_then(|v| v.as_str()).map(str::to_string)
            .unwrap_or_else(|| note_title(rel, body));
        hits.push(SearchHit {
            rel: rel.to_string(),
            title,
            snippet: tokens.iter().map(|t| snippet_around(body, t)).find(|s| s.len() < 200).unwrap_or_default(),
        });
    }
    Ok(hits)
}

/// 实时扫描（单字符等短词回退路径）
fn scan_search(root: &str, query: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
    let q = query.to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();
    for rel in vault_files(root) {
        let Ok(text) = fs::read_to_string(safe_join(root, &rel)?) else { continue };
        let lower = text.to_lowercase();
        let Some(idx) = lower.find(&q) else { continue };
        let bytes = text.as_bytes();
        let mut start = idx.saturating_sub(40);
        while start < bytes.len() && (bytes[start] & 0xC0) == 0x80 {
            start += 1;
        }
        let mut end = (idx + q.len() + 60).min(bytes.len());
        while end > start && end < bytes.len() && (bytes[end] & 0xC0) == 0x80 {
            end -= 1;
        }
        hits.push(SearchHit {
            rel: rel.clone(),
            title: note_title(&rel, &text),
            snippet: text[start..end].replace('\n', " "),
        });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

/// Rust 侧全文搜索：tantivy 索引（BM25 排序），命中返回片段
#[derive(serde::Serialize)]
struct SearchHit {
    rel: String,
    title: String,
    snippet: String,
}

#[tauri::command]
fn vault_search(root: String, query: String, limit: Option<usize>) -> Result<Vec<SearchHit>, String> {
    indexed_search(&root, &query, limit.unwrap_or(50))
}

#[tauri::command]
fn vault_issues_load(root: String) -> Result<Value, String> {
    let loaded = load_issues(&root)?;
    Ok(json!({
        "issues": loaded.store.issues,
        "mtime": loaded.mtime,
        "created": loaded.created,
        "migrated": loaded.migrated,
        "removed": loaded.removed,
    }))
}

#[tauri::command]
fn vault_issues_save(root: String, issues: Vec<Issue>) -> Result<u64, String> {
    let mut ids = HashSet::new();
    for issue in &issues {
        if issue.id.trim().is_empty() {
            return Err("Issue id 不能为空".into());
        }
        if !ids.insert(issue.id.as_str()) {
            return Err(format!("Issue id 重复：{}", issue.id));
        }
        if issue.title.trim().is_empty() {
            return Err(format!("Issue {} 的标题不能为空", issue.id));
        }
        if !ISSUE_STATUSES.contains(&issue.status.as_str()) {
            return Err(format!("Issue {} 的状态非法：{}", issue.id, issue.status));
        }
        if !ISSUE_PRIORITIES.contains(&issue.priority.as_str()) {
            return Err(format!("Issue {} 的优先级非法：{}", issue.id, issue.priority));
        }
        if let Some(due) = issue.due.as_deref() {
            if !valid_due_date(due) {
                return Err(format!("Issue {} 的截止日期非法：{due}", issue.id));
            }
        }
    }
    write_issue_store(&root, &IssueStore { version: issue_store_version(), issues })
}

/* ==================== MCP 写入权限（GUI 与 --mcp 进程共享） ====================
 * 存放于用户配置目录 pkmx/mcp.json；默认全部允许，MCP 服务端每次调用重读，
 * GUI 里改动即时生效，无需重启 --mcp 进程。
 */

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy)]
struct McpPerms {
    #[serde(default = "default_true")]
    create: bool,
    #[serde(default = "default_true")]
    update: bool,
    #[serde(default = "default_true")]
    append: bool,
    #[serde(default = "default_true")]
    delete: bool,
    /// 视图读取（list_views / get_view / run_view）
    #[serde(default = "default_true")]
    view_read: bool,
    /// 视图管理（create_view / update_view / delete_view）
    #[serde(default = "default_true")]
    view_write: bool,
    /// Issue 读取（list_issues / get_issue）
    #[serde(default = "default_true")]
    issue_read: bool,
    /// Issue 管理（create_issue / create_task / update_issue / delete_issue）
    #[serde(default = "default_true")]
    issue_write: bool,
}

fn default_true() -> bool {
    true
}

impl Default for McpPerms {
    fn default() -> Self {
        Self {
            create: true,
            update: true,
            append: true,
            delete: true,
            view_read: true,
            view_write: true,
            issue_read: true,
            issue_write: true,
        }
    }
}

fn user_config_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let base = std::env::var("APPDATA").ok().map(PathBuf::from);
    #[cfg(not(target_os = "windows"))]
    let base = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".config")));
    base.map(|b| b.join("pkmx"))
}

fn mcp_perms_path() -> Option<PathBuf> {
    user_config_dir().map(|b| b.join("mcp.json"))
}

fn load_mcp_perms() -> McpPerms {
    let Some(p) = mcp_perms_path() else { return McpPerms::default() };
    fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_mcp_perms(perms: &McpPerms) -> Result<(), String> {
    let Some(p) = mcp_perms_path() else { return Err("无法定位用户配置目录".into()) };
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(perms).map_err(|e| e.to_string())?;
    fs::write(p, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn mcp_get_perms() -> McpPerms {
    load_mcp_perms()
}

#[tauri::command]
fn mcp_set_perms(perms: McpPerms) -> Result<(), String> {
    save_mcp_perms(&perms)
}

/* ==================== 共享应用设置（GUI 与 --mcp 进程共用） ==================== */

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct AppSettings {
    /// 仓库内相对目录，空串 = 根目录
    #[serde(default)]
    default_folder: String,
}

fn app_settings_path() -> Option<PathBuf> {
    user_config_dir().map(|b| b.join("settings.json"))
}

/// 归一化仓库内相对目录；含 `..`、盘符等越界输入退回根目录
fn normalize_rel_folder(input: &str) -> String {
    let replaced = input.replace('\\', "/");
    let segs: Vec<&str> = replaced
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    if segs.iter().any(|s| *s == ".." || s.contains(':')) {
        return String::new();
    }
    segs.join("/")
}

fn load_app_settings() -> AppSettings {
    let Some(p) = app_settings_path() else { return AppSettings::default() };
    let mut settings = fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str::<AppSettings>(&s).ok())
        .unwrap_or_default();
    settings.default_folder = normalize_rel_folder(&settings.default_folder);
    settings
}

fn save_app_settings(settings: &AppSettings) -> Result<(), String> {
    let Some(p) = app_settings_path() else { return Err("无法定位用户配置目录".into()) };
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(p, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn app_get_default_folder() -> String {
    load_app_settings().default_folder
}

#[tauri::command]
fn app_set_default_folder(folder: String) -> Result<(), String> {
    save_app_settings(&AppSettings { default_folder: normalize_rel_folder(&folder) })
}

/// 当前可执行文件绝对路径（设置页拼 MCP 接入配置用）
#[tauri::command]
fn app_exe_path() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/* ==================== MCP stdio 服务器（--mcp 模式） ==================== */

/// 毫秒精度（秒级会在同秒内多次修改时漏同步）
fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0))
        .unwrap_or(0)
}

fn vault_files(root: &str) -> Vec<String> {
    let root_path = PathBuf::from(root);
    let mut out = Vec::new();
    collect_md(&root_path, &root_path, &mut out);
    out.retain(|r| r.ends_with(".md"));
    out
}

fn note_title(rel: &str, text: &str) -> String {
    if let Some(m) = text.lines().find(|l| l.starts_with("# ")) {
        return m[2..].trim().to_string();
    }
    let f = rel.rsplit('/').next().unwrap_or(rel);
    f.trim_end_matches(".md").to_string()
}

fn not_found_msg(rel: &str, kind: &str) -> String {
    if kind == "视图" {
        format!("视图不存在：{rel}；可先用 list_views 查看已有视图")
    } else {
        format!("笔记不存在：{rel}；可先用 search_notes 查找正确路径")
    }
}

fn ensure_file(path: &Path, rel: &str, kind: &str) -> Result<(), String> {
    if !path.exists() {
        return Err(not_found_msg(rel, kind));
    }
    if !path.is_file() {
        return Err(format!("{kind}路径不是普通文件：{rel}"));
    }
    Ok(())
}

fn read_text_friendly(path: &Path, rel: &str, kind: &str) -> Result<String, String> {
    ensure_file(path, rel, kind)?;
    fs::read_to_string(path).map_err(|e| format!("读取{kind} {rel} 失败：{e}"))
}

fn valid_due_date(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
        return false;
    }
    let (Ok(y), Ok(m), Ok(d)) = (
        parts[0].parse::<i32>(),
        parts[1].parse::<u32>(),
        parts[2].parse::<u32>(),
    ) else {
        return false;
    };
    if !(1..=12).contains(&m) {
        return false;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    (1..=days).contains(&d)
}

fn validate_filter_list(value: &str, allowed: &[&str], field: &str) -> Result<(), String> {
    let mut any = false;
    for part in value.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        any = true;
        if !allowed.contains(&part) {
            return Err(format!(
                "{field} 只能包含 {}（收到 {part}）",
                allowed.join("/")
            ));
        }
    }
    if !any {
        return Err(format!("{field} 不能为空"));
    }
    Ok(())
}

fn split_frontmatter(text: &str) -> (Option<&str>, &str) {
    let Some(rest) = text.strip_prefix("---\r\n").or_else(|| text.strip_prefix("---\n")) else {
        return (None, text);
    };
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
        if trimmed == "---" {
            return (Some(&rest[..offset]), &rest[offset + line.len()..]);
        }
        offset += line.len();
    }
    (None, text)
}

fn frontmatter_map(block: &str) -> HashMap<String, String> {
    let mut meta = HashMap::new();
    for line in block.lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        let v = v.trim().trim_matches('"').trim_matches('\'');
        if !v.is_empty() {
            meta.insert(k.trim().to_string(), v.to_string());
        }
    }
    meta
}

/* ==================== Issue 独立存储（<vault>/.pkmx/issues.json） ====================
 * Issue 与 Markdown 笔记完全独立：不参与笔记扫描、全文索引或文件树。
 * 旧版「带 status frontmatter 的笔记」在首次加载时一次性迁移进 JSON：
 * 原文件先备份到 .pkmx/legacy-backup/，再从原位置删除。
 */

const ISSUE_STATUSES: [&str; 4] = ["Todo", "Doing", "Blocked", "Done"];
const ISSUE_PRIORITIES: [&str; 4] = ["Low", "Normal", "High", "Urgent"];
const ISSUE_STORE_REL: &str = ".pkmx/issues.json";

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct Issue {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default = "issue_default_status")]
    status: String,
    #[serde(default = "issue_default_priority")]
    priority: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    due: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    done: Option<String>,
    #[serde(default)]
    created: String,
    #[serde(default)]
    updated: String,
    /// 从旧 Markdown 任务迁移而来时的原相对路径（用于幂等与失败重试）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    legacy: Option<String>,
}

fn issue_default_status() -> String {
    "Todo".into()
}

fn issue_default_priority() -> String {
    "Normal".into()
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct IssueStore {
    #[serde(default = "issue_store_version")]
    version: u32,
    #[serde(default)]
    issues: Vec<Issue>,
}

fn issue_store_version() -> u32 {
    1
}

impl Default for IssueStore {
    fn default() -> Self {
        Self { version: issue_store_version(), issues: Vec::new() }
    }
}

fn issue_today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn new_issue_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("iss_{ms:x}_{seq:x}")
}

fn issues_path(root: &str) -> PathBuf {
    PathBuf::from(root).join(ISSUE_STORE_REL)
}

fn read_issue_store(root: &str) -> Result<(IssueStore, bool), String> {
    let path = issues_path(root);
    if !path.exists() {
        return Ok((IssueStore::default(), false));
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取 Issue 存储失败：{e}"))?;
    let store: IssueStore = serde_json::from_str(&text)
        .map_err(|e| format!("Issue 数据格式损坏（{}）：{e}", path.display()))?;
    Ok((store, true))
}

/// 原子写入：先写临时文件再替换，避免中途崩溃留下半截 JSON
fn write_issue_store(root: &str, store: &IssueStore) -> Result<u64, String> {
    let path = issues_path(root);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建 Issue 目录失败：{e}"))?;
    }
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("写入 Issue 存储失败：{e}"))?;
    if let Err(first) = fs::rename(&tmp, &path) {
        // Windows 目标文件被占用时 rename 可能失败：退一步先移除旧文件
        fs::remove_file(&path)
            .map_err(|_| format!("保存 Issue 存储失败：{first}"))?;
        fs::rename(&tmp, &path).map_err(|e| format!("保存 Issue 存储失败：{e}"))?;
    }
    Ok(mtime_ms(&path))
}

/// 去掉正文开头的一级标题（标题已作为 Issue.title 独立保存）
fn strip_leading_h1(body: &str) -> String {
    let mut out = String::new();
    let mut skipped = false;
    for line in body.lines() {
        if !skipped && line.starts_with("# ") {
            skipped = true;
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim().to_string()
}

/// 备份并删除一个仍是旧任务格式的 Markdown 文件；返回是否真的删除
fn backup_and_remove_legacy(root: &str, rel: &str) -> Result<bool, String> {
    let src = safe_join(root, rel)?;
    if !src.is_file() {
        return Ok(false);
    }
    let Ok(text) = fs::read_to_string(&src) else { return Ok(false) };
    let (meta_text, _) = split_frontmatter(&text);
    let Some(meta_text) = meta_text else { return Ok(false) };
    let meta = frontmatter_map(meta_text);
    let Some(status) = meta.get("status") else { return Ok(false) };
    if !ISSUE_STATUSES.contains(&status.as_str()) {
        return Ok(false);
    }
    let backup = PathBuf::from(root).join(".pkmx").join("legacy-backup").join(rel);
    if let Some(dir) = backup.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("备份旧任务失败：{e}"))?;
    }
    fs::copy(&src, &backup).map_err(|e| format!("备份旧任务 {rel} 失败：{e}"))?;
    fs::remove_file(&src).map_err(|e| format!("删除已迁移的旧任务 {rel} 失败：{e}"))?;
    Ok(true)
}

/// 扫描旧任务笔记并转成 Issue；不落盘、不删除，由调用方先保存 JSON
fn migrate_legacy_tasks(root: &str, store: &mut IssueStore) -> Vec<String> {
    let known: HashSet<String> = store.issues.iter().filter_map(|i| i.legacy.clone()).collect();
    let mut migrated = Vec::new();
    for rel in vault_files(root) {
        if known.contains(&rel) {
            continue;
        }
        let Ok(path) = safe_join(root, &rel) else { continue };
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let (meta_text, body) = split_frontmatter(&text);
        let Some(meta_text) = meta_text else { continue };
        let meta = frontmatter_map(meta_text);
        let Some(status) = meta.get("status").map(String::as_str) else { continue };
        if !ISSUE_STATUSES.contains(&status) {
            continue;
        }
        let priority = meta
            .get("priority")
            .map(String::as_str)
            .filter(|p| ISSUE_PRIORITIES.contains(p))
            .unwrap_or("Normal");
        let due = meta
            .get("due")
            .filter(|d| valid_due_date(d))
            .cloned();
        let created = meta.get("created").cloned().unwrap_or_else(issue_today);
        let done = meta
            .get("done")
            .cloned()
            .or_else(|| (status == "Done").then(issue_today));
        let title = note_title(&rel, &text);
        store.issues.push(Issue {
            id: new_issue_id(),
            title,
            body: strip_leading_h1(body),
            status: status.to_string(),
            priority: priority.to_string(),
            due,
            done,
            created,
            updated: issue_today(),
            legacy: Some(rel.clone()),
        });
        migrated.push(rel);
    }
    migrated
}

struct LoadedIssues {
    store: IssueStore,
    created: bool,
    migrated: Vec<String>,
    removed: Vec<String>,
    mtime: u64,
}

/// 读取 Issue；文件不存在时执行一次性迁移。迁移先保存 JSON，再备份并删除原 Markdown。
fn load_issues(root: &str) -> Result<LoadedIssues, String> {
    let path = issues_path(root);
    let existed = path.exists();
    let (mut store, _) = read_issue_store(root)?;
    let mut normalized = false;
    for issue in &mut store.issues {
        if issue.status == "Wont" {
            // 放弃功能已移除：历史 Wont 重新打开为待办，避免数据不可见
            issue.status = "Todo".into();
            issue.done = None;
            normalized = true;
        }
    }
    let migrated = if existed { Vec::new() } else { migrate_legacy_tasks(root, &mut store) };

    if !existed || normalized || !migrated.is_empty() {
        write_issue_store(root, &store)?;
    }

    // JSON 已存在也重试：上次删除失败（如文件被占用）时继续清理
    let mut removed = Vec::new();
    for issue in &store.issues {
        if let Some(rel) = issue.legacy.as_deref() {
            if backup_and_remove_legacy(root, rel)? {
                removed.push(rel.to_string());
            }
        }
    }
    Ok(LoadedIssues { store, created: !existed, migrated, removed, mtime: mtime_ms(&path) })
}

fn normalize_issue_title(args: &Value) -> Result<Option<String>, String> {
    let Some(raw) = args.get("title").and_then(|v| v.as_str()) else {
        return Ok(None);
    };
    let title = raw.trim();
    if title.is_empty() {
        return Err("title 不能为空".into());
    }
    if title.contains(['\n', '\r']) {
        return Err("title 不能包含换行".into());
    }
    Ok(Some(title.to_string()))
}

fn normalize_issue_status(args: &Value) -> Result<Option<String>, String> {
    let Some(raw) = args.get("status").and_then(|v| v.as_str()) else {
        return Ok(None);
    };
    let status = raw.trim();
    if !ISSUE_STATUSES.contains(&status) {
        return Err(format!("status 只能是 Todo/Doing/Blocked/Done（收到 {status}）"));
    }
    Ok(Some(status.to_string()))
}

fn normalize_issue_priority(args: &Value) -> Result<Option<String>, String> {
    let Some(raw) = args.get("priority").and_then(|v| v.as_str()) else {
        return Ok(None);
    };
    let priority = raw.trim();
    if !ISSUE_PRIORITIES.contains(&priority) {
        return Err(format!("priority 只能是 Low/Normal/High/Urgent（收到 {priority}）"));
    }
    Ok(Some(priority.to_string()))
}

/// `due` 允许空串表示清空
fn normalize_issue_due(args: &Value) -> Result<Option<Option<String>>, String> {
    let Some(raw) = args.get("due").and_then(|v| v.as_str()) else {
        return Ok(None);
    };
    let due = raw.trim();
    if due.is_empty() {
        return Ok(Some(None));
    }
    if !valid_due_date(due) {
        return Err(format!("due 必须是 YYYY-MM-DD 日期（收到 {due}）"));
    }
    Ok(Some(Some(due.to_string())))
}

/// 将 Issue 按视图过滤条件筛选（与前端 runView 行为一致）
fn filter_issues(store: &IssueStore, filters: &Value, limit: usize) -> Vec<Issue> {
    let status_filter = filters.get("status").and_then(|v| v.as_str());
    let priority_filter = filters.get("priority").and_then(|v| v.as_str());
    let text_filter = filters.get("text").and_then(|v| v.as_str()).map(str::to_lowercase);
    let due_filter = filters.get("due").and_then(|v| v.as_str()).unwrap_or("all");
    let today = Local::now().date_naive();
    let monday = today - Duration::days(today.weekday().num_days_from_monday() as i64);
    let sunday = monday + Duration::days(6);
    let today_str = today.format("%Y-%m-%d").to_string();

    let mut issues: Vec<Issue> = store
        .issues
        .iter()
        .filter(|issue| {
            if let Some(want) = status_filter {
                if !want.split(',').map(str::trim).any(|s| s == issue.status) {
                    return false;
                }
            }
            if let Some(want) = priority_filter {
                if !want.split(',').map(str::trim).any(|s| s == issue.priority) {
                    return false;
                }
            }
            if let Some(q) = &text_filter {
                let haystack = format!("{}\n{}", issue.title, issue.body).to_lowercase();
                if !haystack.contains(q) {
                    return false;
                }
            }
            match due_filter {
                "today" => issue.due.as_deref() == Some(today_str.as_str()),
                "overdue" => issue.due.as_deref().is_some_and(|d| d < today_str.as_str()),
                "week" => issue
                    .due
                    .as_deref()
                    .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
                    .is_some_and(|d| d >= monday && d <= sunday),
                _ => true,
            }
        })
        .cloned()
        .collect();
    issues.sort_by(|a, b| {
        let due_key = |i: &Issue| i.due.clone().unwrap_or_else(|| "9999-99-99".into());
        due_key(a)
            .cmp(&due_key(b))
            .then_with(|| a.title.cmp(&b.title))
    });
    issues.truncate(limit);
    issues
}

// ---- 视图（views 目录下的 .yml，扁平键：name/status/priority/due/text） ----

fn view_rel_check(rel: &str) -> Result<(), String> {
    if !rel.starts_with("views/") || !rel.ends_with(".yml") {
        return Err("视图路径必须是 views/xxx.yml".into());
    }
    Ok(())
}

fn parse_view_yml(text: &str) -> (String, Value) {
    let mut name = String::new();
    let mut obj = serde_json::Map::new();
    for line in text.lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        let (k, v) = (k.trim(), v.trim());
        if v.is_empty() {
            continue;
        }
        if k == "name" {
            name = v.to_string();
        } else if matches!(k, "status" | "priority" | "due" | "text") {
            obj.insert(k.to_string(), json!(v));
        }
    }
    (name, Value::Object(obj))
}

/// 由参数生成视图 yml（name 必填，status/priority/due/text 可选；update 为全量替换语义）
fn render_view_yml(name: &str, args: &Value) -> Result<String, String> {
    if name.contains(['/', '\\']) || name.trim() == ".." {
        return Err("视图名不能包含路径分隔符".into());
    }
    if let Some(due) = args.get("due").and_then(|d| d.as_str()) {
        if !["all", "today", "week", "overdue"].contains(&due.trim()) {
            return Err(format!("due 只能是 all/today/week/overdue（收到 {due}）"));
        }
    }
    if let Some(status) = args.get("status").and_then(|v| v.as_str()) {
        validate_filter_list(
            status,
            &["Todo", "Doing", "Blocked", "Done"],
            "status",
        )?;
    }
    if let Some(priority) = args.get("priority").and_then(|v| v.as_str()) {
        validate_filter_list(
            priority,
            &["Low", "Normal", "High", "Urgent"],
            "priority",
        )?;
    }
    let mut lines = vec![format!("name: {name}")];
    for k in ["status", "priority", "due", "text"] {
        if let Some(v) = args.get(k).and_then(|x| x.as_str()).map(str::trim) {
            if v.is_empty() {
                continue;
            }
            if v.contains(['\n', '\r']) {
                return Err(format!("{k} 不能包含换行"));
            }
            lines.push(format!("{k}: {v}"));
        }
    }
    Ok(lines.join("\n") + "\n")
}

fn tool(name: &str, desc: &str, props: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": desc,
        "inputSchema": { "type": "object", "properties": props, "required": required }
    })
}

fn mcp_tools() -> Value {
    let perms = load_mcp_perms();
    // 禁用的工具在描述里标注，agent 在 tools/list 阶段就能看到
    let mark = |mut t: Value, allowed: bool| {
        if !allowed {
            let d = t["description"].as_str().unwrap_or("").to_string();
            t["description"] = Value::String(format!("{d}；⚠ 用户已在 PKMX 设置中禁用此工具，调用会被拒绝"));
        }
        t
    };
    let search = tool(
        "search_notes",
        "在仓库中按关键词搜索笔记，返回路径与标题列表",
        json!({
            "query": { "type": "string", "description": "关键词，匹配标题或正文" },
            "limit": { "type": "integer", "description": "最多返回条数，默认 20" }
        }),
        &["query"],
    );
    let get = tool(
        "get_note",
        "读取一篇笔记的完整内容与修改时间",
        json!({
            "rel": { "type": "string", "description": "仓库相对路径，如 开发/xxx.md" }
        }),
        &["rel"],
    );
    let create = tool(
        "create_note",
        "创建一篇新笔记（Markdown，可含 frontmatter）",
        json!({
            "rel": { "type": "string" },
            "content": { "type": "string" }
        }),
        &["rel", "content"],
    );
    let update = tool(
        "update_note",
        "整篇覆写笔记（笔记必须已存在，新建请用 create_note）。可带 expected_mtime（unix 毫秒，来自 get_note）做修改时间守卫，不匹配则拒绝并返回当前 mtime",
        json!({
            "rel": { "type": "string" },
            "content": { "type": "string" },
            "expected_mtime": { "type": "integer", "description": "读取时获得的 mtime（unix 毫秒），防止读改写竞争" }
        }),
        &["rel", "content"],
    );
    let create_task = tool(
        "create_task",
        "create_issue 的兼容别名：创建一个 Issue（独立存于 .pkmx/issues.json，不是 Markdown 笔记）",
        json!({
            "title": { "type": "string", "description": "Issue 标题" },
            "body": { "type": "string", "description": "描述（Markdown，可选）" },
            "status": {
                "type": "string",
                "enum": ["Todo", "Doing", "Blocked", "Done"],
                "description": "状态，默认 Todo"
            },
            "priority": {
                "type": "string",
                "enum": ["Low", "Normal", "High", "Urgent"],
                "description": "优先级，默认 Normal"
            },
            "due": { "type": "string", "description": "截止日期 YYYY-MM-DD（可选）" }
        }),
        &["title"],
    );
    let issue_fields = json!({
        "title": { "type": "string", "description": "Issue 标题" },
        "body": { "type": "string", "description": "描述（Markdown，可选）" },
        "status": {
            "type": "string",
            "enum": ["Todo", "Doing", "Blocked", "Done"],
            "description": "状态"
        },
        "priority": {
            "type": "string",
            "enum": ["Low", "Normal", "High", "Urgent"],
            "description": "优先级"
        },
        "due": { "type": "string", "description": "截止日期 YYYY-MM-DD；更新时传空串可清空" }
    });
    let list_issues = tool(
        "list_issues",
        "列出 Issue（独立 JSON 存储，与笔记分离）。可按状态/优先级/截止日期/文本过滤，按截止日期排序",
        json!({
            "status": { "type": "string", "description": "状态过滤，逗号分隔：Todo, Doing, Blocked, Done" },
            "priority": { "type": "string", "description": "优先级过滤，逗号分隔：Low, Normal, High, Urgent" },
            "due": { "type": "string", "enum": ["all", "today", "week", "overdue"] },
            "text": { "type": "string", "description": "标题或描述关键词" },
            "limit": { "type": "integer", "description": "最多返回条数，默认 100" }
        }),
        &[],
    );
    let get_issue = tool(
        "get_issue",
        "读取一个 Issue 的完整内容与 Issue 存储文件的 mtime（unix 毫秒）",
        json!({
            "id": { "type": "string", "description": "Issue id，如 iss_..." }
        }),
        &["id"],
    );
    let create_issue = tool(
        "create_issue",
        "创建一个 Issue（独立存于 <仓库>/.pkmx/issues.json，不写入 Markdown）",
        issue_fields.clone(),
        &["title"],
    );
    let update_issue = tool(
        "update_issue",
        "修改 Issue（只更新提供的字段）。due 传空串可清空；status 改为 Done 自动记录完成日期。可带 expected_mtime 守卫（来自 get_issue）",
        {
            let mut p = issue_fields.clone();
            p["id"] = json!({ "type": "string" });
            p["expected_mtime"] = json!({ "type": "integer", "description": "读取时获得的 mtime，防止读改写竞争" });
            p
        },
        &["id"],
    );
    let delete_issue = tool(
        "delete_issue",
        "删除一个 Issue（不可恢复）。可带 expected_mtime 守卫",
        json!({
            "id": { "type": "string" },
            "expected_mtime": { "type": "integer", "description": "可选 mtime 守卫（unix 毫秒）" }
        }),
        &["id"],
    );
    let append = tool(
        "append_to_note",
        "在笔记末尾追加内容（笔记必须已存在）",
        json!({
            "rel": { "type": "string" },
            "content": { "type": "string" }
        }),
        &["rel", "content"],
    );
    let delete = tool(
        "delete_note",
        "删除一篇笔记（不可恢复）。可带 expected_mtime（unix 毫秒，来自 get_note）守卫，防止误删已被修改的笔记",
        json!({
            "rel": { "type": "string" },
            "expected_mtime": { "type": "integer", "description": "可选 mtime 守卫（unix 毫秒）" }
        }),
        &["rel"],
    );
    let view_filters = json!({
        "name": { "type": "string", "description": "视图名（文件名与显示名）" },
        "status": { "type": "string", "description": "状态过滤，逗号分隔：Todo, Doing, Blocked, Done" },
        "priority": { "type": "string", "description": "优先级过滤，逗号分隔：Low, Normal, High, Urgent" },
        "due": { "type": "string", "enum": ["all", "today", "week", "overdue"] },
        "text": { "type": "string", "description": "全文关键词" }
    });
    let vlist = tool(
        "list_views",
        "列出仓库全部保存视图（views/*.yml）及其过滤条件",
        json!({}),
        &[],
    );
    let vget = tool(
        "get_view",
        "读取一个视图的原始 yml 与解析后的过滤条件",
        json!({ "rel": { "type": "string", "description": "如 views/进行中.yml" } }),
        &["rel"],
    );
    let vrun = tool(
        "run_view",
        "运行保存视图，返回匹配的 Issue（数据存于 .pkmx/issues.json）：状态/优先级/截止日期/文本过滤与界面一致",
        json!({
            "rel": { "type": "string", "description": "如 views/进行中.yml" },
            "limit": { "type": "integer", "description": "最多返回条数，默认 100" }
        }),
        &["rel"],
    );
    let vcreate = tool(
        "create_view",
        "创建保存视图（写入 views/<name>.yml）。status/priority/due/text 均可选",
        view_filters.clone(),
        &["name"],
    );
    let vupdate = tool(
        "update_view",
        "修改视图。过滤条件为全量替换（未提供的键会被移除，name 未提供则保留原名）；可带 expected_mtime 守卫",
        {
            let mut p = view_filters.clone();
            p["rel"] = json!({ "type": "string", "description": "如 views/进行中.yml" });
            p["expected_mtime"] = json!({ "type": "integer", "description": "读取时获得的 mtime，防止读改写竞争" });
            p
        },
        &["rel"],
    );
    let vdelete = tool(
        "delete_view",
        "删除一个视图文件",
        json!({
            "rel": { "type": "string" },
            "expected_mtime": { "type": "integer", "description": "可选 mtime 守卫" }
        }),
        &["rel"],
    );
    json!([
        search,
        get,
        mark(create, perms.create),
        mark(create_task, perms.issue_write),
        mark(update, perms.update),
        mark(append, perms.append),
        mark(delete, perms.delete),
        mark(list_issues, perms.issue_read),
        mark(get_issue, perms.issue_read),
        mark(create_issue, perms.issue_write),
        mark(update_issue, perms.issue_write),
        mark(delete_issue, perms.issue_write),
        mark(vlist, perms.view_read),
        mark(vget, perms.view_read),
        mark(vrun, perms.view_read),
        mark(vcreate, perms.view_write),
        mark(vupdate, perms.view_write),
        mark(vdelete, perms.view_write)
    ])
}

fn mcp_create_issue(root: &str, args: &Value) -> Result<Value, String> {
    let title = normalize_issue_title(args)?.ok_or("title required")?;
    let status = normalize_issue_status(args)?.unwrap_or_else(|| "Todo".into());
    let priority = normalize_issue_priority(args)?.unwrap_or_else(|| "Normal".into());
    let due = normalize_issue_due(args)?.flatten();
    let body = args["body"].as_str().unwrap_or("").trim().to_string();
    let today = issue_today();
    let issue = Issue {
        id: new_issue_id(),
        title,
        body,
        status: status.clone(),
        priority,
        due,
        done: (status == "Done").then(|| today.clone()),
        created: today.clone(),
        updated: today,
        legacy: None,
    };
    let mut loaded = load_issues(root)?;
    loaded.store.issues.push(issue.clone());
    let mtime = write_issue_store(root, &loaded.store)?;
    let mut out = serde_json::to_value(&issue).map_err(|e| e.to_string())?;
    out["mtime"] = json!(mtime);
    Ok(out)
}

fn mcp_update_issue(root: &str, args: &Value) -> Result<Value, String> {
    let id = args["id"].as_str().ok_or("id required")?;
    let title = normalize_issue_title(args)?;
    let status = normalize_issue_status(args)?;
    let priority = normalize_issue_priority(args)?;
    let due_patch = normalize_issue_due(args)?;
    let body_patch = args.get("body").and_then(|v| v.as_str()).map(|s| s.to_string());
    let mut loaded = load_issues(root)?;
    let path = issues_path(root);
    if let Some(exp) = args["expected_mtime"].as_u64() {
        let cur = mtime_ms(&path);
        if cur != exp {
            return Err(format!(
                "mtime 不匹配：Issue 已被其他方修改（当前 {cur}，期望 {exp}，unix 毫秒）。请重新 get_issue"
            ));
        }
    }
    let today = issue_today();
    let Some(issue) = loaded.store.issues.iter_mut().find(|i| i.id == id) else {
        return Err(format!("Issue 不存在：{id}；可先用 list_issues 查看"));
    };
    if let Some(title) = title {
        issue.title = title;
    }
    if let Some(body) = body_patch {
        issue.body = body;
    }
    if let Some(status) = status {
        if status == "Done" {
            if issue.done.is_none() {
                issue.done = Some(today.clone());
            }
        } else {
            issue.done = None;
        }
        issue.status = status;
    }
    if let Some(priority) = priority {
        issue.priority = priority;
    }
    if let Some(due) = due_patch {
        issue.due = due;
    }
    issue.updated = today;
    let out = serde_json::to_value(&*issue).map_err(|e| e.to_string())?;
    let mtime = write_issue_store(root, &loaded.store)?;
    let mut out = out;
    out["mtime"] = json!(mtime);
    Ok(out)
}

fn mcp_delete_issue(root: &str, args: &Value) -> Result<Value, String> {
    let id = args["id"].as_str().ok_or("id required")?;
    let mut loaded = load_issues(root)?;
    let path = issues_path(root);
    if let Some(exp) = args["expected_mtime"].as_u64() {
        let cur = mtime_ms(&path);
        if cur != exp {
            return Err(format!(
                "mtime 不匹配：Issue 已被其他方修改（当前 {cur}，期望 {exp}，unix 毫秒）。请重新 get_issue"
            ));
        }
    }
    let Some(pos) = loaded.store.issues.iter().position(|i| i.id == id) else {
        return Err(format!("Issue 不存在：{id}；可先用 list_issues 查看"));
    };
    loaded.store.issues.remove(pos);
    let mtime = write_issue_store(root, &loaded.store)?;
    Ok(json!({ "id": id, "deleted": true, "mtime": mtime }))
}

fn mcp_call(name: &str, root: &str, args: &Value) -> Result<Value, String> {
    // 写入类工具每次调用重读权限文件，GUI 改动即时生效
    let perms = load_mcp_perms();
    // 笔记与视图分属不同工具与权限，笔记工具一律拒绝视图路径
    let note_rel = |rel: &str| -> Result<(), String> {
        if rel.starts_with("views/") {
            Err(format!("{rel} 是视图文件，请使用视图工具（list_views / get_view / create_view / update_view / delete_view）"))
        } else if rel.split(['/', '\\']).any(|seg| seg.starts_with('.')) {
            Err(format!(
                "{rel} 位于内部数据目录，笔记工具不可访问；Issue 数据请使用 Issue 工具（list_issues / create_issue / update_issue / delete_issue）"
            ))
        } else {
            Ok(())
        }
    };
    match name {
        "search_notes" => {
            let query = args["query"].as_str().unwrap_or("");
            let limit = args["limit"].as_u64().unwrap_or(20) as usize;
            let hits = indexed_search(root, query, limit)?;
            let notes: Vec<Value> = hits
                .iter()
                .map(|h| json!({ "rel": h.rel, "title": h.title, "snippet": h.snippet }))
                .collect();
            Ok(json!({ "count": notes.len(), "notes": notes }))
        }
        "get_note" => {
            let rel = args["rel"].as_str().ok_or("rel required")?;
            note_rel(rel)?;
            let path = safe_join(root, rel)?;
            let text = read_text_friendly(&path, rel, "笔记")?;
            Ok(json!({ "rel": rel, "title": note_title(rel, &text), "mtime": mtime_ms(&path), "content": text }))
        }
        "create_note" => {
            if !perms.create {
                return Err("权限拒绝：create_note 已在 PKMX 设置（MCP 权限）中禁用".into());
            }
            let rel = args["rel"].as_str().ok_or("rel required")?;
            note_rel(rel)?;
            let content = args["content"].as_str().unwrap_or("");
            let path = safe_join(root, rel)?;
            if path.exists() {
                return Err(format!("{rel} 已存在；如需覆写请用 update_note"));
            }
            if let Some(p) = path.parent() {
                fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            fs::write(&path, content).map_err(|e| e.to_string())?;
            Ok(json!({ "rel": rel, "created": true }))
        }
        "create_task" | "create_issue" => {
            if !perms.issue_write {
                return Err(format!(
                    "权限拒绝：{name} 已在 PKMX 设置（MCP 权限 → Issue）中禁用"
                ));
            }
            mcp_create_issue(root, args)
        }
        "list_issues" => {
            if !perms.issue_read {
                return Err("权限拒绝：list_issues 已在 PKMX 设置（MCP 权限 → Issue）中禁用".into());
            }
            let loaded = load_issues(root)?;
            let limit = args["limit"].as_u64().unwrap_or(100) as usize;
            let issues = filter_issues(&loaded.store, args, limit);
            Ok(json!({ "count": issues.len(), "issues": issues, "mtime": loaded.mtime }))
        }
        "get_issue" => {
            if !perms.issue_read {
                return Err("权限拒绝：get_issue 已在 PKMX 设置（MCP 权限 → Issue）中禁用".into());
            }
            let id = args["id"].as_str().ok_or("id required")?;
            let loaded = load_issues(root)?;
            let Some(issue) = loaded.store.issues.iter().find(|i| i.id == id) else {
                return Err(format!("Issue 不存在：{id}；可先用 list_issues 查看"));
            };
            let mut out = serde_json::to_value(issue).map_err(|e| e.to_string())?;
            out["mtime"] = json!(loaded.mtime);
            Ok(out)
        }
        "update_issue" => {
            if !perms.issue_write {
                return Err("权限拒绝：update_issue 已在 PKMX 设置（MCP 权限 → Issue）中禁用".into());
            }
            mcp_update_issue(root, args)
        }
        "delete_issue" => {
            if !perms.issue_write {
                return Err("权限拒绝：delete_issue 已在 PKMX 设置（MCP 权限 → Issue）中禁用".into());
            }
            mcp_delete_issue(root, args)
        }
        "update_note" => {
            if !perms.update {
                return Err("权限拒绝：update_note 已在 PKMX 设置（MCP 权限）中禁用".into());
            }
            let rel = args["rel"].as_str().ok_or("rel required")?;
            note_rel(rel)?;
            let content = args["content"].as_str().unwrap_or("");
            let path = safe_join(root, rel)?;
            ensure_file(&path, rel, "笔记")?;
            if let Some(exp) = args["expected_mtime"].as_u64() {
                let cur = mtime_ms(&path);
                if cur != exp {
                    return Err(format!("mtime 不匹配：笔记已被其他方修改（当前 {cur}，期望 {exp}，unix 毫秒）。请重新 get_note"));
                }
            }
            fs::write(&path, content).map_err(|e| format!("写入笔记 {rel} 失败：{e}"))?;
            Ok(json!({ "rel": rel, "updated": true, "mtime": mtime_ms(&path) }))
        }
        "append_to_note" => {
            if !perms.append {
                return Err("权限拒绝：append_to_note 已在 PKMX 设置（MCP 权限）中禁用".into());
            }
            let rel = args["rel"].as_str().ok_or("rel required")?;
            note_rel(rel)?;
            let content = args["content"].as_str().unwrap_or("");
            let path = safe_join(root, rel)?;
            let mut text = read_text_friendly(&path, rel, "笔记")?;
            if !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(content);
            fs::write(&path, &text).map_err(|e| format!("写入笔记 {rel} 失败：{e}"))?;
            Ok(json!({ "rel": rel, "appended": true }))
        }
        "delete_note" => {
            if !perms.delete {
                return Err("权限拒绝：delete_note 已在 PKMX 设置（MCP 权限）中禁用".into());
            }
            let rel = args["rel"].as_str().ok_or("rel required")?;
            note_rel(rel)?;
            let path = safe_join(root, rel)?;
            ensure_file(&path, rel, "笔记")?;
            if let Some(exp) = args["expected_mtime"].as_u64() {
                let cur = mtime_ms(&path);
                if cur != exp {
                    return Err(format!("mtime 不匹配：笔记已被其他方修改（当前 {cur}，期望 {exp}，unix 毫秒）。请重新 get_note"));
                }
            }
            fs::remove_file(&path).map_err(|e| format!("删除笔记 {rel} 失败：{e}"))?;
            Ok(json!({ "rel": rel, "deleted": true }))
        }
        "list_views" => {
            if !perms.view_read {
                return Err("权限拒绝：list_views 已在 PKMX 设置（MCP 权限 → 视图）中禁用".into());
            }
            let mut out = Vec::new();
            if let Ok(entries) = fs::read_dir(PathBuf::from(root).join("views")) {
                for e in entries.flatten() {
                    let fname = e.file_name().to_string_lossy().to_string();
                    if !fname.ends_with(".yml") {
                        continue;
                    }
                    let Ok(text) = fs::read_to_string(e.path()) else { continue };
                    let (vname, filters) = parse_view_yml(&text);
                    let display = if vname.is_empty() { fname.trim_end_matches(".yml").to_string() } else { vname };
                    out.push(json!({
                        "rel": format!("views/{fname}"),
                        "name": display,
                        "filters": filters,
                        "mtime": mtime_ms(&e.path()),
                    }));
                }
            }
            out.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
            Ok(json!({ "count": out.len(), "views": out }))
        }
        "get_view" => {
            if !perms.view_read {
                return Err("权限拒绝：get_view 已在 PKMX 设置（MCP 权限 → 视图）中禁用".into());
            }
            let rel = args["rel"].as_str().ok_or("rel required")?;
            view_rel_check(rel)?;
            let path = safe_join(root, rel)?;
            let text = read_text_friendly(&path, rel, "视图")?;
            let (vname, filters) = parse_view_yml(&text);
            Ok(json!({ "rel": rel, "name": vname, "filters": filters, "mtime": mtime_ms(&path), "content": text }))
        }
        "run_view" => {
            if !perms.view_read {
                return Err("权限拒绝：run_view 已在 PKMX 设置（MCP 权限 → 视图）中禁用".into());
            }
            let rel = args["rel"].as_str().ok_or("rel required")?;
            view_rel_check(rel)?;
            let path = safe_join(root, rel)?;
            let text = read_text_friendly(&path, rel, "视图")?;
            let (vname, filters) = parse_view_yml(&text);
            let limit = args["limit"].as_u64().unwrap_or(100) as usize;
            let loaded = load_issues(root)?;
            let issues = filter_issues(&loaded.store, &filters, limit);
            Ok(json!({
                "rel": rel,
                "name": vname,
                "filters": filters,
                "count": issues.len(),
                "issues": issues,
                "mtime": loaded.mtime,
            }))
        }
        "create_view" => {
            if !perms.view_write {
                return Err("权限拒绝：create_view 已在 PKMX 设置（MCP 权限 → 视图）中禁用".into());
            }
            let name = args["name"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("name required")?;
            let yml = render_view_yml(name, args)?;
            let rel = format!("views/{name}.yml");
            let path = safe_join(root, &rel)?;
            if path.exists() {
                return Err(format!("{rel} 已存在；修改请用 update_view"));
            }
            if let Some(p) = path.parent() {
                fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            fs::write(&path, yml).map_err(|e| e.to_string())?;
            Ok(json!({ "rel": rel, "created": true }))
        }
        "update_view" => {
            if !perms.view_write {
                return Err("权限拒绝：update_view 已在 PKMX 设置（MCP 权限 → 视图）中禁用".into());
            }
            let rel = args["rel"].as_str().ok_or("rel required")?;
            view_rel_check(rel)?;
            let path = safe_join(root, rel)?;
            ensure_file(&path, rel, "视图")?;
            if let Some(exp) = args["expected_mtime"].as_u64() {
                let cur = mtime_ms(&path);
                if cur != exp {
                    return Err(format!("mtime 不匹配：视图已被其他方修改（当前 {cur}，期望 {exp}，unix 毫秒）。请重新 get_view"));
                }
            }
            let old = read_text_friendly(&path, rel, "视图")?;
            let (old_name, _) = parse_view_yml(&old);
            let name = args["name"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(&old_name);
            let yml = render_view_yml(name, args)?;
            fs::write(&path, yml).map_err(|e| format!("写入视图 {rel} 失败：{e}"))?;
            Ok(json!({ "rel": rel, "updated": true, "mtime": mtime_ms(&path) }))
        }
        "delete_view" => {
            if !perms.view_write {
                return Err("权限拒绝：delete_view 已在 PKMX 设置（MCP 权限 → 视图）中禁用".into());
            }
            let rel = args["rel"].as_str().ok_or("rel required")?;
            view_rel_check(rel)?;
            let path = safe_join(root, rel)?;
            ensure_file(&path, rel, "视图")?;
            if let Some(exp) = args["expected_mtime"].as_u64() {
                let cur = mtime_ms(&path);
                if cur != exp {
                    return Err(format!("mtime 不匹配：视图已被其他方修改（当前 {cur}，期望 {exp}，unix 毫秒）"));
                }
            }
            fs::remove_file(&path).map_err(|e| format!("删除视图 {rel} 失败：{e}"))?;
            Ok(json!({ "rel": rel, "deleted": true }))
        }
        other => Err(format!("未知工具 {other}")),
    }
}

/// `pkmx.exe --mcp [--vault <dir>]`：以 MCP stdio 服务器运行（不打开窗口）
pub fn run_mcp(vault: Option<String>) -> i32 {
    let root = match vault {
        Some(v) => v,
        None => {
            eprintln!("用法：pkmx --mcp --vault <仓库路径>");
            return 2;
        }
    };
    if !Path::new(&root).is_dir() {
        eprintln!("仓库路径不存在：{root}");
        return 2;
    }
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut line = String::new();
    loop {
        line.clear();
        match stdin.lock().read_line(&mut line) {
            Ok(0) => return 0, // EOF
            Ok(_) => {}
            Err(_) => return 1,
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let id = req.get("id").cloned();
        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let result: Option<Result<Value, String>> = match method {
            "initialize" => Some(Ok(json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "pkmx-mcp", "version": "0.1.0" }
            }))),
            "notifications/initialized" => None,
            "tools/list" => Some(Ok(json!({ "tools": mcp_tools() }))),
            "tools/call" => {
                let name = req["params"]["name"].as_str().unwrap_or("");
                match mcp_call(name, &root, &req["params"]["arguments"]) {
                    Ok(v) => Some(Ok(json!({ "content": [ { "type": "text", "text": v.to_string() } ] }))),
                    Err(e) => Some(Ok(json!({ "isError": true, "content": [ { "type": "text", "text": e } ] }))),
                }
            }
            m => Some(Err(format!("未知方法 {m}"))),
        };
        if id.is_none() {
            continue; // 通知或无法回应
        }
        let resp = match result {
            Some(Ok(v)) => json!({ "jsonrpc": "2.0", "id": id, "result": v }),
            Some(Err(e)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": e } }),
            None => continue,
        };
        let _ = writeln!(stdout, "{}", resp);
        let _ = stdout.flush();
    }
}

/// GUI 模式 `--vault <dir>`：启动时直接打开指定仓库（跳过选择界面）
#[tauri::command]
fn initial_vault() -> Option<String> {
    INITIAL_VAULT.lock().ok().and_then(|g| g.clone())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(vault_arg: Option<String>) {
    if let Some(v) = vault_arg {
        if let Ok(mut slot) = INITIAL_VAULT.lock() {
            *slot = Some(v);
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            vault_list,
            vault_read,
            vault_write,
            vault_delete,
            vault_rename_root,
            vault_rename_dir,
            vault_delete_dir,
            vault_write_bin,
            vault_read_bin,
            vault_watch,
            vault_search,
            vault_issues_load,
            vault_issues_save,
            initial_vault,
            mcp_get_perms,
            mcp_set_perms,
            app_get_default_folder,
            app_set_default_folder,
            app_exe_path,
            path_is_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
