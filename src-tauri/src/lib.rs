use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::mpsc;

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
    /// 视图读取（list_views / get_view）
    #[serde(default = "default_true")]
    view_read: bool,
    /// 视图管理（create_view / update_view / delete_view）
    #[serde(default = "default_true")]
    view_write: bool,
}

fn default_true() -> bool {
    true
}

impl Default for McpPerms {
    fn default() -> Self {
        Self { create: true, update: true, append: true, view_read: true, view_write: true }
    }
}

fn mcp_perms_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let base = std::env::var("APPDATA").ok().map(PathBuf::from);
    #[cfg(not(target_os = "windows"))]
    let base = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".config")));
    base.map(|b| b.join("pkmx").join("mcp.json"))
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

/// 当前可执行文件绝对路径（设置页拼 MCP 接入配置用）
#[tauri::command]
fn app_exe_path() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/* ==================== MCP stdio 服务器（--mcp 模式） ==================== */

fn mtime_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0))
        .unwrap_or(0)
}

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
        "整篇覆写笔记。可带 expected_mtime（unix 秒）做修改时间守卫，不匹配则拒绝并返回当前 mtime",
        json!({
            "rel": { "type": "string" },
            "content": { "type": "string" },
            "expected_mtime": { "type": "integer", "description": "读取时获得的 mtime，防止读改写竞争" }
        }),
        &["rel", "content"],
    );
    let append = tool(
        "append_to_note",
        "在笔记末尾追加内容",
        json!({
            "rel": { "type": "string" },
            "content": { "type": "string" }
        }),
        &["rel", "content"],
    );
    let view_filters = json!({
        "name": { "type": "string", "description": "视图名（文件名与显示名）" },
        "status": { "type": "string", "description": "状态过滤，逗号分隔：Todo, Doing, Blocked, Done, Wont" },
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
        mark(update, perms.update),
        mark(append, perms.append),
        mark(vlist, perms.view_read),
        mark(vget, perms.view_read),
        mark(vcreate, perms.view_write),
        mark(vupdate, perms.view_write),
        mark(vdelete, perms.view_write)
    ])
}

fn mcp_call(name: &str, root: &str, args: &Value) -> Result<Value, String> {
    // 写入类工具每次调用重读权限文件，GUI 改动即时生效
    let perms = load_mcp_perms();
    // 笔记与视图分属不同工具与权限，笔记工具一律拒绝视图路径
    let note_rel = |rel: &str| -> Result<(), String> {
        if rel.starts_with("views/") {
            Err(format!("{rel} 是视图文件，请使用视图工具（list_views / get_view / create_view / update_view / delete_view）"))
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
            let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            Ok(json!({ "rel": rel, "title": note_title(rel, &text), "mtime": mtime_secs(&path), "content": text }))
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
        "update_note" => {
            if !perms.update {
                return Err("权限拒绝：update_note 已在 PKMX 设置（MCP 权限）中禁用".into());
            }
            let rel = args["rel"].as_str().ok_or("rel required")?;
            note_rel(rel)?;
            let content = args["content"].as_str().unwrap_or("");
            let path = safe_join(root, rel)?;
            if let Some(exp) = args["expected_mtime"].as_u64() {
                let cur = mtime_secs(&path);
                if cur != exp {
                    return Err(format!("mtime 不匹配：文件已被其他方修改（当前 {cur}，期望 {exp}）。请重新 get_note"));
                }
            }
            fs::write(&path, content).map_err(|e| e.to_string())?;
            Ok(json!({ "rel": rel, "updated": true, "mtime": mtime_secs(&path) }))
        }
        "append_to_note" => {
            if !perms.append {
                return Err("权限拒绝：append_to_note 已在 PKMX 设置（MCP 权限）中禁用".into());
            }
            let rel = args["rel"].as_str().ok_or("rel required")?;
            note_rel(rel)?;
            let content = args["content"].as_str().unwrap_or("");
            let path = safe_join(root, rel)?;
            let mut text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            if !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(content);
            fs::write(&path, &text).map_err(|e| e.to_string())?;
            Ok(json!({ "rel": rel, "appended": true }))
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
                        "mtime": mtime_secs(&e.path()),
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
            let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let (vname, filters) = parse_view_yml(&text);
            Ok(json!({ "rel": rel, "name": vname, "filters": filters, "mtime": mtime_secs(&path), "content": text }))
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
            if !path.exists() {
                return Err(format!("{rel} 不存在"));
            }
            if let Some(exp) = args["expected_mtime"].as_u64() {
                let cur = mtime_secs(&path);
                if cur != exp {
                    return Err(format!("mtime 不匹配：视图已被其他方修改（当前 {cur}，期望 {exp}）。请重新 get_view"));
                }
            }
            let old = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let (old_name, _) = parse_view_yml(&old);
            let name = args["name"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(&old_name);
            let yml = render_view_yml(name, args)?;
            fs::write(&path, yml).map_err(|e| e.to_string())?;
            Ok(json!({ "rel": rel, "updated": true, "mtime": mtime_secs(&path) }))
        }
        "delete_view" => {
            if !perms.view_write {
                return Err("权限拒绝：delete_view 已在 PKMX 设置（MCP 权限 → 视图）中禁用".into());
            }
            let rel = args["rel"].as_str().ok_or("rel required")?;
            view_rel_check(rel)?;
            let path = safe_join(root, rel)?;
            if !path.exists() {
                return Err(format!("{rel} 不存在"));
            }
            if let Some(exp) = args["expected_mtime"].as_u64() {
                let cur = mtime_secs(&path);
                if cur != exp {
                    return Err(format!("mtime 不匹配：视图已被其他方修改（当前 {cur}，期望 {exp}）"));
                }
            }
            fs::remove_file(&path).map_err(|e| e.to_string())?;
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
            initial_vault,
            mcp_get_perms,
            mcp_set_perms,
            app_exe_path,
            path_is_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
