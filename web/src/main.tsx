import { Component, type ErrorInfo, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";
import App from "./App.tsx";
import "./styles.css";

/**
 * 错误边界：任何渲染期异常都显示具体报错，而不是白屏。
 * 方便测试时直接把信息贴回来。
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state: { err: Error | null } = { err: null };

  static getDerivedStateFromError(err: Error): { err: Error | null } {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    console.error("渲染异常:", err, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.err) {
      return (
        <div className="center">
          <div className="err">
            <strong>页面渲染出错</strong>
            <pre>{this.state.err.message}</pre>
            <p>请把这段信息发给我，同时打开 F12 看 Console 里的完整堆栈。</p>
            <button type="button" onClick={() => this.setState({ err: null })}>
              重试
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("缺少 #root 节点");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
