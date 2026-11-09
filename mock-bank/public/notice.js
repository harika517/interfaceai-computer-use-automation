// E-10: on-page "System Notice" popup. It covers the page, so nothing else can
// be clicked until it is acknowledged. A native alert() is deliberately not
// used: Playwright silently dismisses those, so automation would never see it.
(function () {
  const notice = document.getElementById("system-notice");
  const button = document.getElementById("acknowledge-notice");
  if (!notice || !button) return;
  button.focus();
  button.addEventListener("click", () => notice.remove());
})();
