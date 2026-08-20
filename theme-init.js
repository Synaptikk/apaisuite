(function () {
  try {
    var saved = localStorage.getItem("shell.theme") || "system";
    var resolved = saved;
    if (saved === "system") {
      resolved = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", resolved);
  } catch (e) {}
})();
