// Shows the message the shell asked for in the address's fragment.
(function () {
  var messages = {
    starting: { title: "Starting Lurkloot…", detail: "" },
    restarting: {
      title: "Restarting Lurkloot…",
      detail: "The farming service stopped. It is starting again.",
    },
    failed: {
      title: "Lurkloot keeps stopping",
      detail:
        "The farming service stopped several times in a row. It will keep trying. If this goes on, quit Lurkloot from the tray and open it again; serve.log in the app's log folder says why.",
    },
  };
  function show() {
    var key = window.location.hash.replace(/^#/, "");
    var message = messages[key] || messages.starting;
    document.getElementById("title").textContent = message.title;
    document.getElementById("detail").textContent = message.detail;
    document.body.dataset.state = key || "starting";
  }
  window.addEventListener("hashchange", show);
  show();
})();
