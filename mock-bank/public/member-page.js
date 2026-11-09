// Same-page account switching for the Member Details card.
// Safeguards against stale results:
//  - every click clears the details area before anything new is shown;
//  - each request gets a sequence number, and only the latest one may render;
//  - a response must match the current member and the selected account type.
(function () {
  const card = document.querySelector("[data-member-id]");
  if (!card) return;

  const memberId = card.getAttribute("data-member-id");
  const details = document.getElementById("account-details");
  const buttons = Array.from(card.querySelectorAll(".actions button"));
  let latestRequest = 0;
  let selectedType = null;

  function markSelected(activeButton) {
    for (const button of buttons) {
      const isActive = button === activeButton;
      button.classList.toggle("selected", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function show(...nodes) {
    details.replaceChildren(...nodes);
  }

  function row(label, value) {
    const line = element("div", "row");
    line.append(element("span", "label", label), element("span", "value", value));
    return line;
  }

  function renderAccount(view) {
    const heading = element("h3", null, view.accountName);
    if (view.state === "not_on_file" || view.state === "permission_denied") {
      show(heading, element("p", view.state === "permission_denied" ? "error" : "muted", view.message));
      return;
    }
    const nodes = [heading, row("Account Number", view.accountNumberMasked), row("Status", view.status)];
    if (view.state === "active") {
      const balance = element("div", "balance");
      balance.append(element("div", "label", "Balance"), element("div", "amount", view.balance));
      nodes.push(element("hr"), balance);
    }
    show(...nodes);
  }

  async function loadAccount(button, accountType) {
    const requestId = ++latestRequest;
    selectedType = accountType;
    markSelected(button);
    const accountName = button.textContent.trim();
    show(element("h3", null, accountName), element("p", "muted", `Loading ${accountName.toLowerCase()}…`));

    try {
      const response = await fetch(
        `/members/${encodeURIComponent(memberId)}/accounts/${accountType}`,
        { headers: { Accept: "application/json" }, credentials: "same-origin" },
      );
      if (requestId !== latestRequest) return;
      if (response.status === 401) {
        window.location.assign("/login?reason=expired");
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const view = await response.json();
      if (requestId !== latestRequest || view.memberId !== memberId || view.accountType !== selectedType) return;
      renderAccount(view);
    } catch {
      if (requestId !== latestRequest) return;
      show(element("h3", null, accountName), element("p", "error", "Unable to load account details. Please try again."));
    }
  }

  function showUnavailable(button, message) {
    latestRequest++; // any in-flight account response is now outdated
    selectedType = null;
    markSelected(button);
    show(element("h3", null, button.textContent.trim()), element("p", "muted", message));
  }

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const accountType = button.getAttribute("data-account");
      if (accountType) loadAccount(button, accountType);
      else showUnavailable(button, button.getAttribute("data-unavailable"));
    });
  }
})();
