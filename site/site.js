(function () {
  "use strict";
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".terminal-tabs button"));
  var views = {
    matrix: document.getElementById("view-matrix"),
    list: document.getElementById("view-list"),
    json: document.getElementById("view-json")
  };
  function selectTab(btn) {
    var name = btn.getAttribute("data-view");
    tabs.forEach(function (b) {
      var on = b === btn;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
    Object.keys(views).forEach(function (k) {
      if (views[k]) views[k].hidden = k !== name;
    });
  }
  tabs.forEach(function (btn, i) {
    btn.addEventListener("click", function () { selectTab(btn); });
    btn.addEventListener("keydown", function (e) {
      var dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (e.key === "Home") dir = -999;
      else if (e.key === "End") dir = 999;
      if (!dir && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      var next = (i + dir + tabs.length) % tabs.length;
      if (dir === -999) next = 0;
      if (dir === 999) next = tabs.length - 1;
      selectTab(tabs[next]);
      tabs[next].focus();
    });
  });
  var copyBtn = document.getElementById("copyInstall");
  var installCmd = document.getElementById("installCmd");
  if (copyBtn && installCmd) {
    copyBtn.addEventListener("click", function () {
      var done = function () {
        copyBtn.textContent = "Copied";
        setTimeout(function () { copyBtn.textContent = "Copy"; }, 1500);
      };
      var text = installCmd.textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        var ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e) {}
        document.body.removeChild(ta);
        done();
      }
    });
  }
  var toggle = document.getElementById("themeToggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var html = document.documentElement;
      var light = html.getAttribute("data-theme") !== "light";
      html.setAttribute("data-theme", light ? "light" : "dark");
      toggle.textContent = light ? "Dark" : "Light";
      toggle.setAttribute("aria-pressed", light ? "true" : "false");
    });
  }
})();
