import { useEffect, useRef, useState } from "react";

// ⚠️ 这里改成你的公众号名称（弹窗里会展示给用户）
const ACCOUNT_NAME = "大模型血战三国";
const QR_SRC = `${import.meta.env.BASE_URL}qrcode-wechat.jpg`;

const THRESHOLD_MS = 3 * 60 * 1000; // 留存 3 分钟
const EVER_KEY = "sanguo:follow-prompt-ever"; // 已关注 → 永久不再弹
const SESSION_KEY = "sanguo:follow-prompt-session"; // 本会话已提示过

/**
 * 留存转化弹窗：累计"页面可见且有焦点"的时间，达到 3 分钟后弹一次。
 * 全局挂载在 App 根上，跨首页/直播/回放所有路由共享同一个计时器。
 * 纯前端实现，GitHub Pages 静态模式与连接后端模式均生效。
 */
export function FollowPrompt() {
  const [show, setShow] = useState(false);
  const dismissedRef = useRef(false);

  const dismiss = (permanent: boolean) => {
    if (permanent) localStorage.setItem(EVER_KEY, "1");
    else sessionStorage.setItem(SESSION_KEY, "1");
    dismissedRef.current = true;
    setShow(false);
  };

  useEffect(() => {
    if (localStorage.getItem(EVER_KEY) || sessionStorage.getItem(SESSION_KEY)) return;

    let elapsed = 0;
    let lastActiveAt: number | null = null;
    let timer: number | undefined;

    const isActive = () => document.visibilityState === "visible" && document.hasFocus();

    const consider = () => {
      if (dismissedRef.current) {
        stop();
        return;
      }
      const now = Date.now();
      if (isActive()) {
        if (lastActiveAt !== null) elapsed += now - lastActiveAt;
        lastActiveAt = now;
        if (elapsed >= THRESHOLD_MS) {
          stop();
          setShow(true);
        }
      } else {
        // 页面不可见/失焦：暂停累积，恢复时重新计基准
        lastActiveAt = null;
      }
    };

    const onVis = () => {
      if (isActive() && lastActiveAt === null) lastActiveAt = Date.now();
    };

    const stop = () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
      window.removeEventListener("blur", onVis);
    };

    timer = window.setInterval(consider, 1000);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    window.addEventListener("blur", onVis);
    return stop;
  }, []);

  useEffect(() => {
    if (!show) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show]);

  if (!show) return null;

  return (
    <div className="follow-overlay" role="dialog" aria-modal="true" onClick={() => dismiss(false)}>
      <div className="follow-modal" onClick={(event) => event.stopPropagation()}>
        <button className="follow-close" aria-label="关闭" onClick={() => dismiss(false)}>×</button>
        <h2>喜欢这盘大棋？</h2>
        <p>想第一时间围观大模型逐鹿中原？<br />关注公众号，随时来观战。</p>
        <img className="follow-qr" src={QR_SRC} alt="公众号二维码" width={220} height={220} />
        <p className="follow-hint">长按识别二维码 · 或微信搜索「{ACCOUNT_NAME}」</p>
        <div className="follow-actions">
          <button className="primary" onClick={() => dismiss(true)}>已关注，继续观战</button>
          <button className="ghost" onClick={() => dismiss(false)}>先观战，稍后再说</button>
        </div>
      </div>
    </div>
  );
}
