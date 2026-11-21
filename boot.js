/* Shows a helpful message instead of a blank page if the app fails to start. */
(function () {
  var errs = [];
  window.addEventListener("error", function (e) { errs.push((e.message || "error") + (e.filename ? " (" + e.filename.split("/").pop() + ":" + e.lineno + ")" : "")); });
  window.addEventListener("load", function () {
    setTimeout(function () {
      var app = document.getElementById("app"), login = document.getElementById("login");
      if (!app || !login || !app.hidden || !login.hidden) return;
      var box = document.createElement("section");
      box.className = "card c-amber";
      var h = document.createElement("h2"); h.textContent = "The app didn't start";
      var p = document.createElement("p");
      p.textContent = "Press Ctrl + Shift + R to reload. If it still shows this, some app files are missing or old: copy all files from Reminders-web.zip into the Reminder folder again, replacing them.";
      var d = document.createElement("p"); d.className = "muted"; d.textContent = errs.length ? "Details: " + errs.join(" | ") : "Details: app.js did not run.";
      var b = document.createElement("button"); b.textContent = "Reset and reload";
      b.onclick = function () {
        var done = function () { location.reload(); };
        if (navigator.serviceWorker) navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); })
          .then(function () { return window.caches ? caches.keys().then(function (k) { return Promise.all(k.map(function (x) { return caches.delete(x); })); }) : 0; }).then(done, done);
        else done();
      };
      box.append(h, p, d, b);
      (document.querySelector("main") || document.body).prepend(box);
    }, 2500);
  });
})();
