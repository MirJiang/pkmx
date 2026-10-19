import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

/** 顶层错误边界：开发期直接显示错误，避免白屏难排查 */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null; stack: string | null }
> {
  state: { error: Error | null; stack: string | null } = { error: null, stack: null };

  static getDerivedStateFromError(error: Error) {
    return { error, stack: null };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("PKMX crashed:", error, info);
    this.setState({ stack: info.componentStack ?? null });
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: "monospace", fontSize: 13, whiteSpace: "pre-wrap" }}>
          <h1 style={{ fontSize: 18, marginBottom: 12 }}>界面出错</h1>
          <div style={{ color: "#b3372a" }}>{this.state.error.message}</div>
          <pre style={{ marginTop: 12, opacity: 0.7 }}>{this.state.error.stack}</pre>
          {this.state.stack && (
            <pre style={{ marginTop: 12, opacity: 0.7 }}>组件栈：{this.state.stack}</pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
