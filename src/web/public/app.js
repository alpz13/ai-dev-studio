(function () {
  var STAGES = ["PM", "Architect", "Dev", "QA", "DevOps"];

  var startPanel = document.getElementById("start-panel");
  var resumePanel = document.getElementById("resume-panel");
  var sessionPanel = document.getElementById("session-panel");
  var pendingListEl = document.getElementById("pending-list");
  var stageBadgesEl = document.getElementById("stage-badges");
  var logEl = document.getElementById("log");
  var sessionFeatureIdEl = document.getElementById("session-feature-id");
  var summaryPanelEl = document.getElementById("summary-panel");
  var summaryContentEl = document.getElementById("summary-content");
  var startForm = document.getElementById("start-form");
  var taskInput = document.getElementById("task-input");
  var backButton = document.getElementById("back-button");

  var currentSource = null;
  var stageStatus = {};

  function resetStages() {
    stageStatus = {};
    STAGES.forEach(function (s) { stageStatus[s] = "pending"; });
    renderStages();
  }

  function renderStages() {
    stageBadgesEl.innerHTML = "";
    STAGES.forEach(function (stage) {
      var el = document.createElement("div");
      el.className = "stage-badge";
      el.dataset.status = stageStatus[stage];
      el.innerHTML = '<span class="dot"></span>' + stage;
      stageBadgesEl.appendChild(el);
    });
  }

  function appendLog(event) {
    var line = document.createElement("div");
    line.className = "line" + (event.event === "error" ? " error" : "");
    var ts = event.timestamp ? event.timestamp.split("T")[1].replace("Z", "") : "";
    var detail = "";
    if (event.event === "message" && event.note) detail = event.note;
    else if (event.event === "tool_call" && event.tool) detail = "tool: " + event.tool;
    else if (event.event === "tool_result" && event.tool) detail = "tool result: " + event.tool + (event.isError ? " (error)" : "");
    else if (event.event === "agent_end" && event.output) detail = String(event.output).slice(0, 160);
    else if (event.event === "error" && event.output) detail = String(event.output).slice(0, 200);
    var nesting = event.parentSpanId ? " ↳ " : "";
    line.innerHTML =
      '<span class="ts">[' + ts + ']</span> ' +
      nesting +
      '<span class="role">' + event.agentRole + '</span> ' +
      '<span class="evt">' + event.event + '</span>' +
      (detail ? " &mdash; " + escapeHtml(detail) : "");
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; });
  }

  function applyEventToStages(event) {
    // Only top-level stage spans move the badges — a subagent (Dev
    // delegating a piece of work, Phase 4) has parentSpanId set and shares
    // the same agentRole, so it must not double-drive the Dev badge.
    if (event.parentSpanId) return;

    if (STAGES.indexOf(event.agentRole) !== -1) {
      if (event.event === "agent_start") stageStatus[event.agentRole] = "in_progress";
      else if (event.event === "agent_end") stageStatus[event.agentRole] = "done";
      else if (event.event === "error") stageStatus[event.agentRole] = "failed";
      renderStages();
      return;
    }

    // The Director's own "message" events carry the QA-retry signal: QA's
    // agent_end already marked it "done" above, but if the verdict wasn't
    // actually approved the Director logs this instead of moving on.
    if (event.agentRole === "Director" && event.event === "message" && event.stage === "QA" && /retry/i.test(String(event.note))) {
      stageStatus.QA = "failed";
      stageStatus.Dev = "in_progress";
      renderStages();
    }
  }

  function formatMs(ms) {
    if (ms === null || ms === undefined) return "n/a";
    if (ms < 1000) return ms + "ms";
    return (ms / 1000).toFixed(1) + "s";
  }

  function renderSummary(summary) {
    var totalsHtml =
      '<div class="summary-totals">' +
      '<div class="metric"><div class="value">' + summary.outcome + '</div><div class="label">outcome</div></div>' +
      '<div class="metric"><div class="value">' + formatMs(summary.totalDurationMs) + '</div><div class="label">total duration</div></div>' +
      '<div class="metric"><div class="value">' + summary.totalTokensUsed + '</div><div class="label">tokens used</div></div>' +
      '<div class="metric"><div class="value">' + summary.qaRetries + '</div><div class="label">QA retries</div></div>' +
      '</div>';

    var rows = summary.stages.map(function (s) {
      return (
        "<tr><td>" + s.stage + "</td><td>" + s.runs + "</td><td>" + formatMs(s.durationMs) + "</td><td>" + s.tokensUsed + "</td>" +
        "<td>" + (s.incomplete ? "incomplete" : "") + "</td></tr>"
      );
    }).join("");
    var tableHtml =
      '<table class="summary-stages"><thead><tr><th>Stage</th><th>Runs</th><th>Duration</th><th>Tokens</th><th></th></tr></thead>' +
      "<tbody>" + rows + "</tbody></table>";

    var resumeHtml = (summary.resumeEvents || []).map(function (r) {
      return '<div class="resume-note ' + r.kind + '">' + escapeHtml(r.note) + "</div>";
    }).join("");

    summaryContentEl.innerHTML = totalsHtml + tableHtml + resumeHtml;
    summaryPanelEl.hidden = false;
  }

  function loadSummary(featureId) {
    fetch("/api/features/" + encodeURIComponent(featureId) + "/summary")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (summary) { if (summary) renderSummary(summary); })
      .catch(function () {
        // Best-effort: the live log already told the story, the summary
        // panel is a nice-to-have recap.
      });
  }

  function connect(featureId) {
    if (currentSource) currentSource.close();
    resetStages();
    logEl.innerHTML = "";
    summaryPanelEl.hidden = true;
    summaryContentEl.innerHTML = "";
    sessionFeatureIdEl.textContent = featureId;
    startPanel.hidden = true;
    resumePanel.hidden = true;
    sessionPanel.hidden = false;

    currentSource = new EventSource("/api/features/" + encodeURIComponent(featureId) + "/stream");
    currentSource.onmessage = function (e) {
      var event = JSON.parse(e.data);
      appendLog(event);
      applyEventToStages(event);

      // Once the Director's own span ends (pipeline complete, blocked, or
      // errored), the trace is final for this run — fetch and show the
      // summary (stage durations, tokens, QA retries) computed from it.
      if (!event.parentSpanId && event.agentRole === "Director" && (event.event === "agent_end" || event.event === "error")) {
        loadSummary(featureId);
      }
    };
    currentSource.onerror = function () {
      // EventSource retries on its own; nothing to do here for this demo.
    };
  }

  function loadPendingFeatures() {
    fetch("/api/features")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var features = data.features || [];
        if (features.length === 0) {
          pendingListEl.innerHTML = '<p class="empty">No pending features.</p>';
          return;
        }
        var ul = document.createElement("ul");
        ul.className = "pending-list";
        features.forEach(function (f) {
          var li = document.createElement("li");
          var left = document.createElement("div");
          left.innerHTML =
            '<div class="title">' + escapeHtml(f.title) + "</div>" +
            '<div class="meta">' + escapeHtml(f.featureId) + " &middot; " + f.status + " &middot; " + f.currentStage + "</div>";
          var button = document.createElement("button");
          button.textContent = "Resume";
          button.addEventListener("click", function () { start({ featureId: f.featureId }); });
          li.appendChild(left);
          li.appendChild(button);
          ul.appendChild(li);
        });
        pendingListEl.innerHTML = "";
        pendingListEl.appendChild(ul);
      })
      .catch(function () {
        pendingListEl.innerHTML = '<p class="empty">Couldn't load pending features.</p>';
      });
  }

  function start(body) {
    fetch("/api/features", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert(data.error); return; }
        connect(data.featureId);
      })
      .catch(function () { alert("Couldn't reach the server."); });
  }

  startForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var task = taskInput.value.trim();
    if (!task) return;
    start({ task: task });
  });

  backButton.addEventListener("click", function () {
    if (currentSource) currentSource.close();
    sessionPanel.hidden = true;
    startPanel.hidden = false;
    resumePanel.hidden = false;
    taskInput.value = "";
    loadPendingFeatures();
  });

  loadPendingFeatures();
})();
