import "dotenv/config";

/**
 * 分享给同事看：把监听地址从 127.0.0.1 改成 0.0.0.0，让同一 Wi-Fi 的人能打开。
 *
 * 只改监听地址，不改数据、不加登录——**它没有鉴权**。
 * 任何能访问该地址的人都能看到本机库里你的对话、错题原文与上传文件。
 * 演示完关掉进程即可；想彻底避免暴露，用一条临时隧道（见 README「分享给别人看」）。
 */

process.env.HOST = "0.0.0.0";
process.env.PORT ??= "8787";

// 先设 env 再加载 server：src/server.ts 在模块顶层就调用 main() 启动监听。
await import("../src/server.js");
