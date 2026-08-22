(function () {
  "use strict";

  const ROOT = document.getElementById("app");

  const ROOM_TYPES = ["Living room", "Bedroom", "Dining", "Balcony"];
  const ITEM_TYPES = {
    "Sofa": ["3+2", "3+3", "L-shape", "Curved"],
    "Dining table": ["4 seater", "6 seater", "8 seater"],
    "Chair": ["Single", "Pair"],
    "Bed": ["Single", "Queen", "King"],
  };
  const MAX_ITEMS = 4;
  const PHASES = ["Reading the room…", "Placing the furniture…", "Setting the light…", "Adding final touches…"];

  let CURRENT_USER = null;

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  function h(strings, ...values) {
    return strings.reduce((out, s, i) => out + s + (i < values.length ? values[i] : ""), "");
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function initials(name) {
    return (name || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0].toUpperCase())
      .join("");
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function toast(message) {
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  async function api(method, path, { json, form } = {}) {
    const opts = { method, credentials: "same-origin" };
    if (json !== undefined) {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(json);
    } else if (form !== undefined) {
      opts.body = form;
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      throw { message: "You seem to be offline. Please check your connection." };
    }
    if (res.status === 401 && path !== "/api/login") {
      CURRENT_USER = null;
      navigate("/login", true);
      throw { message: "Please sign in again." };
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      const message = (data && (data.message || data.detail)) || "Something went wrong. Please try again.";
      throw { message, error: data && data.error };
    }
    return data;
  }

  function fileToPreviewUrl(file) {
    return URL.createObjectURL(file);
  }

  // ---------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------

  const routes = [
    { pattern: /^\/login$/, view: viewLogin, public: true },
    { pattern: /^\/$/, view: viewHome },
    { pattern: /^\/new$/, view: viewSite },
    { pattern: /^\/new\/furniture\/(\d+)$/, view: viewFurniture },
    { pattern: /^\/place\/(\d+)$/, view: viewPlace },
    { pattern: /^\/finish\/(\d+)$/, view: viewFinish },
    { pattern: /^\/generating$/, view: viewGenerating },
    { pattern: /^\/project\/(\d+)$/, view: viewResult },
    { pattern: /^\/admin$/, view: viewAdmin, admin: true },
    { pattern: /^\/admin\/user\/(\d+)$/, view: viewAdminDetail, admin: true },
    { pattern: /^\/admin\/prompt$/, view: viewAdminPrompt, admin: true },
    { pattern: /^\/debug\/generation\/(\d+)$/, view: viewDebugGeneration, admin: true },
  ];

  function navigate(path, replace) {
    if (replace) history.replaceState({}, "", path);
    else history.pushState({}, "", path);
    render();
  }

  window.addEventListener("popstate", render);

  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-link]");
    if (!a) return;
    e.preventDefault();
    navigate(a.getAttribute("href"));
  });

  async function render() {
    const path = window.location.pathname;
    const match = routes.find((r) => r.pattern.test(path));

    if (!match) {
      navigate(CURRENT_USER ? "/" : "/login", true);
      return;
    }

    if (!match.public) {
      if (!CURRENT_USER) {
        try {
          const data = await api("GET", "/api/me");
          CURRENT_USER = data.user;
        } catch (e) {
          // api() already redirected to /login on a 401; for any other
          // failure (e.g. offline), leave a message instead of a blank page.
          if (window.location.pathname !== "/login") {
            ROOT.innerHTML = `<div class="screen"><p class="muted">${esc(e.message || "Something went wrong.")}</p></div>`;
          }
          return;
        }
      }
      if (match.admin && CURRENT_USER.role !== "admin") {
        navigate("/", true);
        return;
      }
    } else if (CURRENT_USER) {
      navigate("/", true);
      return;
    }

    const groups = match.pattern.exec(path);
    ROOT.innerHTML = "";
    try {
      await match.view(ROOT, ...groups.slice(1));
    } catch (err) {
      ROOT.innerHTML = `<div class="screen"><p class="muted">${esc((err && err.message) || "Something went wrong.")}</p></div>`;
    }
  }

  // ---------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------

  function viewLogin(root) {
    root.innerHTML = h`
      <div class="login-screen">
        <div class="logo-block">
          <div class="logo-name">Reflection</div>
          <div class="logo-sub">Lifestyle</div>
        </div>
        <div class="login-tagline">Visualization tool</div>
        <form class="login-form" id="login-form">
          <div id="login-error"></div>
          <div class="field">
            <label>Mobile number</label>
            <input type="tel" id="mobile" inputmode="numeric" autocomplete="username" required />
          </div>
          <div class="field">
            <label>Password</label>
            <input type="password" id="password" autocomplete="current-password" required />
          </div>
          <button class="btn btn-primary" type="submit" id="login-submit">Sign in</button>
        </form>
      </div>
    `;

    root.querySelector("#login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const mobile = root.querySelector("#mobile").value.trim();
      const password = root.querySelector("#password").value;
      const errorBox = root.querySelector("#login-error");
      const submitBtn = root.querySelector("#login-submit");
      errorBox.innerHTML = "";
      submitBtn.disabled = true;
      submitBtn.textContent = "Signing in…";
      try {
        const data = await api("POST", "/api/login", { json: { mobile, password } });
        CURRENT_USER = data.user;
        navigate("/", true);
      } catch (err) {
        errorBox.innerHTML = `<div class="login-error">${esc(err.message)}</div>`;
        submitBtn.disabled = false;
        submitBtn.textContent = "Sign in";
      }
    });
  }

  async function logout() {
    try { await api("POST", "/api/logout"); } catch (e) {}
    CURRENT_USER = null;
    localStorage.removeItem("pendingJob");
    navigate("/login", true);
  }

  // ---------------------------------------------------------------------
  // Home
  // ---------------------------------------------------------------------

  function menuHtml() {
    return h`
      <div class="menu-wrap" style="position:relative;">
        <button class="home-menu-btn" id="menu-btn">&#8942;</button>
        <div id="menu-dropdown" style="display:none;position:absolute;right:0;top:44px;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,0.1);min-width:160px;z-index:20;overflow:hidden;">
          ${CURRENT_USER && CURRENT_USER.role === "admin" ? '<a data-link href="/admin" style="display:block;padding:12px 16px;font-size:13.5px;font-weight:600;border-bottom:1px solid var(--line);">Admin</a>' : ""}
          <a href="#" id="logout-link" style="display:block;padding:12px 16px;font-size:13.5px;font-weight:600;color:#C0392B;">Sign out</a>
        </div>
      </div>
    `;
  }

  function attachMenu(root) {
    const btn = root.querySelector("#menu-btn");
    const dd = root.querySelector("#menu-dropdown");
    if (!btn) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      dd.style.display = dd.style.display === "none" ? "block" : "none";
    });
    document.addEventListener("click", () => { dd.style.display = "none"; }, { once: true });
    const logoutLink = root.querySelector("#logout-link");
    if (logoutLink) logoutLink.addEventListener("click", (e) => { e.preventDefault(); logout(); });
  }

  async function viewHome(root) {
    root.innerHTML = `<div class="screen"><p class="muted">Loading…</p></div>`;
    const data = await api("GET", "/api/projects");
    renderHome(root, data.projects, "");
  }

  function renderHome(root, projects, query) {
    root.innerHTML = h`
      <div class="screen">
        <div class="home-header">
          <div>
            <h1>Hello, ${esc(CURRENT_USER.first_name)}</h1>
            <div class="eyebrow">Reflection Lifestyle</div>
          </div>
          ${menuHtml()}
        </div>
        <a data-link href="/new" class="btn btn-primary">+ New visualization</a>
        <hr class="divider" />
        <div class="recent-label">Recent</div>
        <input class="search-box" id="search" placeholder="Search by customer name" value="${esc(query)}" />
        <div id="grid"></div>
      </div>
    `;
    attachMenu(root);
    paintGrid(root.querySelector("#grid"), projects);

    let t;
    root.querySelector("#search").addEventListener("input", (e) => {
      clearTimeout(t);
      const q = e.target.value;
      t = setTimeout(async () => {
        const data = await api("GET", "/api/projects?q=" + encodeURIComponent(q));
        paintGrid(root.querySelector("#grid"), data.projects);
      }, 250);
    });
  }

  function paintGrid(gridEl, projects) {
    if (!projects.length) {
      gridEl.innerHTML = `<div class="empty-state">No visualizations yet.</div>`;
      return;
    }
    gridEl.innerHTML = `<div class="project-grid">${projects.map((p) => h`
      <a class="project-card" data-link href="/project/${p.id}">
        <img class="thumb" src="${p.thumbnail_url}" loading="lazy" />
        <div class="meta">
          <div class="name">${esc(p.customer_name)}</div>
          <div class="sub">${formatDate(p.created_at)} · ${esc(p.room_type)}</div>
        </div>
      </a>
    `).join("")}</div>`;
  }

  // ---------------------------------------------------------------------
  // New visualization — step 1: site
  // ---------------------------------------------------------------------

  function viewSite(root) {
    let roomType = "";
    let photoFile = null;

    function paint() {
      root.innerHTML = h`
        <div class="screen">
          <div class="top-actions">
            <a data-link href="/" class="back-btn">&#8592;</a>
            <div class="eyebrow">Step 1 of 4</div>
          </div>
          <h1 style="margin-bottom:20px;">New visualization</h1>
          <div class="field">
            <label>Customer name</label>
            <input type="text" id="customer_name" placeholder="e.g. Priya Shah" />
          </div>
          <div class="field">
            <label>Which room?</label>
            <div class="chips" id="room-chips">
              ${ROOM_TYPES.map((r) => `<button type="button" class="chip${r === roomType ? " selected" : ""}" data-room="${esc(r)}">${esc(r)}</button>`).join("")}
            </div>
          </div>
          <div class="field">
            <label>Photo of the space</label>
            <div class="upload-box${photoFile ? " has-image" : ""}" id="upload-box">
              ${photoFile
                ? `<img src="${fileToPreviewUrl(photoFile)}" /><div class="upload-change" id="change-photo">Change photo</div>`
                : `<div id="upload-trigger" style="padding:10px;">Tap to add a photo</div>`}
            </div>
            <input type="file" accept="image/*" id="photo-input" style="display:none;" />
            <div class="hint-line">Stand at the opposite wall, phone at chest height, keep the floor visible.</div>
          </div>
          <button class="btn btn-primary" id="next-btn" style="margin-top:8px;">Next — add furniture</button>
        </div>
      `;

      root.querySelectorAll("[data-room]").forEach((btn) => {
        btn.addEventListener("click", () => { roomType = btn.getAttribute("data-room"); paint(); });
      });

      const fileInput = root.querySelector("#photo-input");
      root.querySelector("#upload-box").addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => {
        if (fileInput.files && fileInput.files[0]) {
          photoFile = fileInput.files[0];
          paint();
        }
      });

      root.querySelector("#customer_name").value = customerNameValue;
      root.querySelector("#customer_name").addEventListener("input", (e) => { customerNameValue = e.target.value; });

      root.querySelector("#next-btn").addEventListener("click", async () => {
        const name = customerNameValue.trim();
        if (!name) return toast("Please enter the customer's name.");
        if (!roomType) return toast("Please choose a room.");
        if (!photoFile) return toast("Please add a photo of the space.");
        const btn = root.querySelector("#next-btn");
        btn.disabled = true;
        btn.textContent = "Creating…";
        const form = new FormData();
        form.append("customer_name", name);
        form.append("room_type", roomType);
        form.append("room_photo", photoFile);
        try {
          const data = await api("POST", "/api/projects", { form });
          navigate("/new/furniture/" + data.project.id);
        } catch (err) {
          toast(err.message);
          btn.disabled = false;
          btn.textContent = "Next — add furniture";
        }
      });
    }

    let customerNameValue = "";
    paint();
  }

  // ---------------------------------------------------------------------
  // New visualization — step 2: furniture
  // ---------------------------------------------------------------------

  async function viewFurniture(root, projectId) {
    root.innerHTML = `<div class="screen"><p class="muted">Loading…</p></div>`;
    const data = await api("GET", "/api/projects/" + projectId);
    let project = data.project;

    let category = "Sofa";
    let type = ITEM_TYPES[category][0];
    let width = "";
    let photoFile = null;

    function paint() {
      const atMax = project.items.length >= MAX_ITEMS;
      root.innerHTML = h`
        <div class="screen">
          <div class="top-actions">
            <a data-link href="/new" class="back-btn">&#8592;</a>
            <div class="eyebrow">Step 2 of 4</div>
          </div>
          <h1 style="margin-bottom:18px;">Add furniture</h1>
          <div id="items-list">
            ${project.items.map((it) => h`
              <div class="item-row">
                <img src="${it.photo_url}" />
                <div class="info">
                  <div class="title">${esc(it.category)} · ${esc(it.type)}</div>
                  <div class="width">${it.width_ft}ft wide</div>
                </div>
                <button class="del" data-del="${it.id}">&times;</button>
              </div>
            `).join("")}
          </div>
          ${atMax ? `<div class="count-hint">Maximum of ${MAX_ITEMS} pieces reached.</div>` : h`
            <div class="add-piece-card">
              <div class="section-label">Add another piece</div>
              <div class="chips" id="cat-chips">
                ${Object.keys(ITEM_TYPES).map((c) => `<button type="button" class="chip${c === category ? " selected" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}
              </div>
              <div class="field" style="margin-top:14px;">
                <label>Photo of the piece</label>
                <div class="upload-box${photoFile ? " has-image" : ""}" id="upload-box">
                  ${photoFile
                    ? `<img src="${fileToPreviewUrl(photoFile)}" /><div class="upload-change" id="change-photo">Change photo</div>`
                    : `<div id="upload-trigger" style="padding:10px;">Tap to add a photo</div>`}
                </div>
                <input type="file" accept="image/*" id="photo-input" style="display:none;" />
              </div>
              <div class="section-label">Type</div>
              <div class="chips" id="type-chips">
                ${ITEM_TYPES[category].map((t) => `<button type="button" class="chip${t === type ? " selected" : ""}" data-type="${esc(t)}">${esc(t)}</button>`).join("")}
              </div>
              <div class="field" style="margin-top:14px;">
                <label>Width (feet)</label>
                <input type="number" id="width" min="0.5" step="0.5" value="${esc(width)}" placeholder="e.g. 7" />
              </div>
              <button class="btn btn-dark" id="add-piece-btn">Add piece</button>
            </div>
          `}
          <button class="btn btn-primary" id="done-btn" style="margin-top:20px;" ${project.items.length ? "" : "disabled"}>Next — place furniture</button>
        </div>
      `;

      root.querySelectorAll("[data-del]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.getAttribute("data-del");
          const data2 = await api("DELETE", `/api/projects/${projectId}/items/${id}`);
          project = data2.project;
          paint();
        });
      });

      if (!atMax) {
        root.querySelectorAll("[data-cat]").forEach((btn) => {
          btn.addEventListener("click", () => {
            category = btn.getAttribute("data-cat");
            type = ITEM_TYPES[category][0];
            paint();
          });
        });
        root.querySelectorAll("[data-type]").forEach((btn) => {
          btn.addEventListener("click", () => { type = btn.getAttribute("data-type"); paint(); });
        });
        const fileInput = root.querySelector("#photo-input");
        root.querySelector("#upload-box").addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", () => {
          if (fileInput.files && fileInput.files[0]) { photoFile = fileInput.files[0]; paint(); }
        });
        const widthInput = root.querySelector("#width");
        widthInput.addEventListener("input", (e) => { width = e.target.value; });

        root.querySelector("#add-piece-btn").addEventListener("click", async () => {
          const w = parseFloat(width);
          if (!photoFile) return toast("Please add a photo of the piece.");
          if (!w || w <= 0) return toast("Please enter a width in feet.");
          const btn = root.querySelector("#add-piece-btn");
          btn.disabled = true;
          btn.textContent = "Adding…";
          const form = new FormData();
          form.append("category", category);
          form.append("type", type);
          form.append("width_ft", String(w));
          form.append("photo", photoFile);
          try {
            const data2 = await api("POST", `/api/projects/${projectId}/items`, { form });
            project = data2.project;
            photoFile = null;
            width = "";
            paint();
          } catch (err) {
            toast(err.message);
            btn.disabled = false;
            btn.textContent = "Add piece";
          }
        });
      }

      root.querySelector("#done-btn").addEventListener("click", () => {
        navigate("/place/" + projectId);
      });
    }

    paint();
  }

  // ---------------------------------------------------------------------
  // New visualization — free-hand placement drawing
  // ---------------------------------------------------------------------

  const STROKE_COLORS = ["#F07522", "#2563EB", "#16A34A", "#9333EA"];

  function clamp01(v) {
    return Math.min(1, Math.max(0, v));
  }

  let placeResizeHandler = null;

  async function viewPlace(root, projectId) {
    root.innerHTML = `<div class="screen"><p class="muted">Loading…</p></div>`;
    const data = await api("GET", "/api/projects/" + projectId);
    let project = data.project;

    if (!project.items.length) {
      navigate("/new/furniture/" + projectId, true);
      return;
    }

    let selectedId = project.items[0].id;
    let activeStroke = null; // normalised {x,y} points while the pointer is down

    root.innerHTML = h`
      <div class="screen">
        <div class="top-actions">
          <a data-link href="/new/furniture/${projectId}" class="back-btn">&#8592;</a>
          <div class="eyebrow">Step 3 of 4</div>
        </div>
        <h1 style="margin-bottom:14px;">Where does each piece go?</h1>
        <div class="place-photo-wrap" id="photo-wrap">
          <img src="${project.room_photo_url}" id="place-img" draggable="false" alt="Room photo" />
          <canvas id="place-canvas"></canvas>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;">
          <button class="btn btn-ghost btn-small" id="undo-btn" style="flex:1;">Undo</button>
          <button class="btn btn-ghost btn-small" id="clear-btn" style="flex:1;">Clear</button>
        </div>
        <div class="hint-line" style="text-align:center;">Select a piece, then draw where it goes</div>
        <div class="chips" id="piece-chips" style="margin-top:14px;">
          ${project.items.map((it, i) => h`
            <button type="button" class="chip${it.id === selectedId ? " selected" : ""}" data-item="${it.id}">
              <span class="chip-dot" style="background:${STROKE_COLORS[i % STROKE_COLORS.length]}"></span>${i + 1} &middot; ${esc(it.category)}
            </button>
          `).join("")}
        </div>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:24px;">
          <button class="btn btn-primary" id="generate-btn">Next</button>
          <button class="btn btn-ghost" id="skip-btn">Skip placement</button>
        </div>
      </div>
    `;

    const img = root.querySelector("#place-img");
    const canvas = root.querySelector("#place-canvas");
    const ctx = canvas.getContext("2d");

    function sizeCanvas() {
      const rect = img.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = rect.width + "px";
      canvas.style.height = rect.height + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function drawPath(points, rect, color, width) {
      if (!points.length) return;
      if (points.length === 1) {
        const p = points[0];
        ctx.beginPath();
        ctx.arc(p.x * rect.width, p.y * rect.height, width / 2, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        return;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      points.forEach((p, i) => {
        const px = p.x * rect.width;
        const py = p.y * rect.height;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }

    function redraw() {
      const rect = img.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      ctx.clearRect(0, 0, rect.width, rect.height);
      const strokeWidth = rect.width * 0.015;
      project.items.forEach((it, i) => {
        const color = STROKE_COLORS[i % STROKE_COLORS.length];
        (it.strokes || []).forEach((stroke) => drawPath(stroke, rect, color, strokeWidth));
      });
      if (activeStroke && activeStroke.length) {
        const idx = project.items.findIndex((it) => it.id === selectedId);
        drawPath(activeStroke, rect, STROKE_COLORS[(idx < 0 ? 0 : idx) % STROKE_COLORS.length], strokeWidth);
      }
    }

    function setupCanvas() {
      sizeCanvas();
      redraw();
    }

    if (img.complete) setupCanvas();
    else img.addEventListener("load", setupCanvas, { once: true });

    if (placeResizeHandler) window.removeEventListener("resize", placeResizeHandler);
    placeResizeHandler = () => setupCanvas();
    window.addEventListener("resize", placeResizeHandler);

    root.querySelectorAll("[data-item]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedId = Number(btn.getAttribute("data-item"));
        root.querySelectorAll("[data-item]").forEach((b) => {
          b.classList.toggle("selected", Number(b.getAttribute("data-item")) === selectedId);
        });
      });
    });

    async function addStroke(itemId, points) {
      const fresh = await api("POST", `/api/projects/${projectId}/items/${itemId}/strokes`, { json: { points } });
      project = fresh.project;
      redraw();
    }

    root.querySelector("#undo-btn").addEventListener("click", async () => {
      try {
        const fresh = await api("POST", `/api/projects/${projectId}/items/${selectedId}/strokes/undo`);
        project = fresh.project;
        redraw();
      } catch (err) {
        toast(err.message);
      }
    });

    root.querySelector("#clear-btn").addEventListener("click", async () => {
      try {
        const fresh = await api("DELETE", `/api/projects/${projectId}/items/${selectedId}/strokes`);
        project = fresh.project;
        redraw();
      } catch (err) {
        toast(err.message);
      }
    });

    root.querySelector("#generate-btn").addEventListener("click", () => {
      navigate("/finish/" + projectId);
    });

    root.querySelector("#skip-btn").addEventListener("click", () => {
      navigate("/finish/" + projectId + "?ignore_placement=true");
    });

    let activePointerId = null;

    canvas.addEventListener("pointerdown", (e) => {
      if (selectedId == null) return;
      activePointerId = e.pointerId;
      canvas.setPointerCapture(activePointerId);
      const rect = img.getBoundingClientRect();
      activeStroke = [{
        x: clamp01((e.clientX - rect.left) / rect.width),
        y: clamp01((e.clientY - rect.top) / rect.height),
      }];
      redraw();
    });

    canvas.addEventListener("pointermove", (e) => {
      if (activeStroke == null || e.pointerId !== activePointerId) return;
      const rect = img.getBoundingClientRect();
      const x = clamp01((e.clientX - rect.left) / rect.width);
      const y = clamp01((e.clientY - rect.top) / rect.height);
      const last = activeStroke[activeStroke.length - 1];
      const dx = (x - last.x) * rect.width;
      const dy = (y - last.y) * rect.height;
      if (Math.hypot(dx, dy) < 2) return;
      activeStroke.push({ x, y });
      redraw();
    });

    async function finishStroke(e) {
      if (activeStroke == null || e.pointerId !== activePointerId) return;
      const points = activeStroke;
      activeStroke = null;
      activePointerId = null;
      try {
        await addStroke(selectedId, points);
      } catch (err) {
        toast(err.message);
        redraw();
      }
    }

    canvas.addEventListener("pointerup", finishStroke);
    canvas.addEventListener("pointercancel", () => {
      activeStroke = null;
      activePointerId = null;
      redraw();
    });
  }

  // ---------------------------------------------------------------------
  // New visualization — finishing touches
  // ---------------------------------------------------------------------

  const ROOM_TREATMENT_OPTIONS = [
    { value: "luxury", label: "Luxury finishing" },
    { value: "minimal", label: "Minimal finishing" },
  ];
  const LIGHTING_OPTIONS = [
    { value: "warm", label: "Warm" },
    { value: "daylight", label: "Daylight" },
    { value: "studio", label: "Studio" },
  ];

  async function viewFinish(root, projectId) {
    root.innerHTML = `<div class="screen"><p class="muted">Loading…</p></div>`;
    const ignorePlacement = new URLSearchParams(window.location.search).get("ignore_placement") === "true";
    const data = await api("GET", "/api/projects/" + projectId);
    const project = data.project;

    let roomTreatment = project.room_treatment || "luxury";
    let lighting = project.lighting || "warm";

    function paint() {
      root.innerHTML = h`
        <div class="screen">
          <div class="top-actions">
            <a data-link href="/place/${projectId}" class="back-btn">&#8592;</a>
            <div class="eyebrow">Step 4 of 4</div>
          </div>
          <h1 style="margin-bottom:20px;">Finishing touches</h1>
          <div class="field">
            <label>How should the room look?</label>
            <div class="chips">
              ${ROOM_TREATMENT_OPTIONS.map((o) => `<button type="button" class="chip${o.value === roomTreatment ? " selected" : ""}" data-treatment="${o.value}">${esc(o.label)}</button>`).join("")}
            </div>
          </div>
          <div class="field">
            <label>Lighting</label>
            <div class="chips">
              ${LIGHTING_OPTIONS.map((o) => `<button type="button" class="chip${o.value === lighting ? " selected" : ""}" data-lighting="${o.value}">${esc(o.label)}</button>`).join("")}
            </div>
          </div>
          <button class="btn btn-primary" id="generate-btn" style="margin-top:12px;">Generate</button>
        </div>
      `;

      root.querySelectorAll("[data-treatment]").forEach((btn) => {
        btn.addEventListener("click", () => {
          roomTreatment = btn.getAttribute("data-treatment");
          paint();
        });
      });
      root.querySelectorAll("[data-lighting]").forEach((btn) => {
        btn.addEventListener("click", () => {
          lighting = btn.getAttribute("data-lighting");
          paint();
        });
      });

      root.querySelector("#generate-btn").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = "Starting…";
        try {
          await api("POST", `/api/projects/${projectId}/finish`, {
            json: { room_treatment: roomTreatment, lighting },
          });
          await startGeneration(projectId, { ignorePlacement });
        } catch (err) {
          toast(err.message);
          btn.disabled = false;
          btn.textContent = "Generate";
        }
      });
    }

    paint();
  }

  async function startGeneration(projectId, opts) {
    const suffix = opts && opts.ignorePlacement ? "?ignore_placement=true" : "";
    const data = await api("POST", `/api/projects/${projectId}/generate${suffix}`);
    localStorage.setItem("pendingJob", JSON.stringify({
      jobId: data.job_id,
      projectId: Number(projectId),
      startedAt: Date.now(),
    }));
    navigate("/generating");
  }

  // ---------------------------------------------------------------------
  // Generating
  // ---------------------------------------------------------------------

  async function viewGenerating(root) {
    const raw = localStorage.getItem("pendingJob");
    if (!raw) { navigate("/", true); return; }
    const job = JSON.parse(raw);

    let project = null;
    try {
      const data = await api("GET", "/api/projects/" + job.projectId);
      project = data.project;
    } catch (e) {}

    function mmss(ms) {
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const r = s % 60;
      return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
    }

    root.innerHTML = h`
      <div class="generating-screen">
        <div class="ring"></div>
        <div class="timer" id="timer">00:00</div>
        <div class="status-line" id="status-line">${PHASES[0]}</div>
        ${project ? h`
          <div class="gen-box">
            <div class="cust">${esc(project.customer_name)}</div>
            <div class="room">${esc(project.room_type)}</div>
            ${project.items.map((it) => h`
              <div class="piece"><span>${esc(it.category)} · ${esc(it.type)}</span><span class="w">${it.width_ft}ft</span></div>
            `).join("")}
          </div>
        ` : ""}
      </div>
    `;

    const timerEl = root.querySelector("#timer");
    const statusEl = root.querySelector("#status-line");

    const tickTimer = setInterval(() => {
      timerEl.textContent = mmss(Date.now() - job.startedAt);
      const phaseIdx = Math.min(PHASES.length - 1, Math.floor((Date.now() - job.startedAt) / 4000));
      statusEl.textContent = PHASES[phaseIdx];
    }, 1000);
    timerEl.textContent = mmss(Date.now() - job.startedAt);

    let stopped = false;
    async function poll() {
      if (stopped) return;
      try {
        const status = await api("GET", "/api/jobs/" + job.jobId);
        if (status.status === "done") {
          stopped = true;
          clearInterval(tickTimer);
          localStorage.removeItem("pendingJob");
          navigate("/project/" + status.project_id, true);
          return;
        }
        if (status.status === "error") {
          stopped = true;
          clearInterval(tickTimer);
          showGenError(root, status.message, job.projectId);
          return;
        }
      } catch (e) {
        if (!CURRENT_USER) return; // session expired; api() already redirected to /login
        // transient network error while polling — keep trying
      }
      setTimeout(poll, 2500);
    }
    poll();
  }

  function showGenError(root, message, projectId) {
    root.innerHTML = h`
      <div class="generating-screen gen-error">
        <div class="status-line">One moment — that didn't go through</div>
        <div class="msg">${esc(message)}</div>
        <div style="width:100%;max-width:280px;display:flex;flex-direction:column;gap:10px;">
          <button class="btn btn-primary" id="retry-btn">Try again</button>
          <a class="btn btn-ghost" data-link href="/new/furniture/${projectId}" style="color:#fff;border-color:rgba(255,255,255,0.3);">Back to pieces</a>
        </div>
      </div>
    `;
    root.querySelector("#retry-btn").addEventListener("click", async (e) => {
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = "Starting…";
      try {
        await startGeneration(projectId);
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        btn.textContent = "Try again";
      }
    });
  }

  // ---------------------------------------------------------------------
  // Result
  // ---------------------------------------------------------------------

  async function viewResult(root, projectId) {
    root.innerHTML = `<div class="screen"><p class="muted">Loading…</p></div>`;
    const data = await api("GET", "/api/projects/" + projectId);
    const project = data.project;
    let showingAfter = true;

    function paint() {
      const renderUrl = project.latest_render ? project.latest_render.image_url : null;
      const imgUrl = showingAfter && renderUrl ? renderUrl : project.room_photo_url;
      root.innerHTML = h`
        <div class="screen">
          <div class="top-actions" style="justify-content:space-between;">
            <a data-link href="/" class="back-btn">&#8592;</a>
            ${CURRENT_USER.role === "admin" && renderUrl ? `<a data-link href="/debug/generation/${project.latest_render.id}" class="mono" style="font-size:12px;font-weight:700;color:var(--orange-d);">Debug &#8250;</a>` : ""}
          </div>
          <div class="result-header">
            <h1>${esc(project.customer_name)}</h1>
            <div class="room">${esc(project.room_type)}</div>
          </div>
          <div class="result-image-wrap" id="zoom-target">
            <img src="${imgUrl}" />
          </div>
          ${renderUrl ? h`
            <div class="toggle-row">
              <button class="toggle-btn${!showingAfter ? " active" : ""}" id="btn-before">Before</button>
              <button class="toggle-btn${showingAfter ? " active" : ""}" id="btn-after">After</button>
            </div>
          ` : `<p class="muted" style="margin-top:14px;">No render yet.</p>`}
          <div class="result-actions">
            <button class="btn btn-green" id="whatsapp-btn" ${renderUrl ? "" : "disabled"}>Send on WhatsApp</button>
            <div class="row2">
              <button class="btn btn-ghost" id="save-btn" ${renderUrl ? "" : "disabled"}>Save to phone</button>
              <button class="btn btn-ghost" id="retry-btn">Try again</button>
            </div>
          </div>
        </div>
      `;

      if (renderUrl) {
        root.querySelector("#btn-before").addEventListener("click", () => { showingAfter = false; paint(); });
        root.querySelector("#btn-after").addEventListener("click", () => { showingAfter = true; paint(); });
      }

      root.querySelector("#zoom-target").addEventListener("click", () => {
        const overlay = document.createElement("div");
        overlay.className = "zoom-overlay";
        overlay.innerHTML = `<img src="${imgUrl}" />`;
        overlay.addEventListener("click", () => overlay.remove());
        document.body.appendChild(overlay);
      });

      root.querySelector("#whatsapp-btn").addEventListener("click", () => shareRender(renderUrl, project));
      root.querySelector("#save-btn").addEventListener("click", () => saveRender(renderUrl));
      root.querySelector("#retry-btn").addEventListener("click", async (e) => {
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = "Starting…";
        try {
          await startGeneration(projectId);
        } catch (err) {
          toast(err.message);
          btn.disabled = false;
          btn.textContent = "Try again";
        }
      });
    }

    paint();
  }

  async function renderToFile(renderUrl) {
    const res = await fetch(renderUrl);
    const blob = await res.blob();
    return new File([blob], "reflection-render.jpg", { type: blob.type || "image/jpeg" });
  }

  async function shareRender(renderUrl, project) {
    if (!renderUrl) return;
    try {
      const file = await renderToFile(renderUrl);
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "Reflection Lifestyle",
          text: `${project.customer_name} — ${project.room_type}`,
        });
        return;
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
    await saveRender(renderUrl);
    toast("Saved — attach it in WhatsApp manually.");
  }

  async function saveRender(renderUrl) {
    if (!renderUrl) return;
    try {
      const file = await renderToFile(renderUrl);
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = "reflection-render.jpg";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) {
      toast("Couldn't save the image. Please try again.");
    }
  }

  // ---------------------------------------------------------------------
  // Admin — salesmen list
  // ---------------------------------------------------------------------

  async function viewAdmin(root) {
    root.innerHTML = `<div class="screen"><p class="muted">Loading…</p></div>`;
    const data = await api("GET", "/api/admin/users");
    renderAdmin(root, data.users);
  }

  function renderAdmin(root, users) {
    root.innerHTML = h`
      <div class="screen">
        <div class="top-actions" style="justify-content:space-between;">
          <a data-link href="/" class="back-btn">&#8592;</a>
          <a data-link href="/admin/prompt" class="mono" style="font-size:12px;font-weight:700;color:var(--orange-d);">Edit prompt &#8250;</a>
        </div>
        <div class="eyebrow">Admin</div>
        <div class="admin-header">
          <h1>Salesmen</h1>
          <div class="admin-count">${users.length}</div>
        </div>
        <input class="search-box" id="search" placeholder="Search by name or number" />
        <div id="user-list"></div>
        <button class="btn btn-dark" id="add-btn" style="margin-top:16px;">+ Add salesman</button>
      </div>
    `;
    paintUserList(root.querySelector("#user-list"), users);

    let t;
    root.querySelector("#search").addEventListener("input", (e) => {
      clearTimeout(t);
      const q = e.target.value;
      t = setTimeout(async () => {
        const data = await api("GET", "/api/admin/users?q=" + encodeURIComponent(q));
        paintUserList(root.querySelector("#user-list"), data.users);
      }, 250);
    });

    root.querySelector("#add-btn").addEventListener("click", () => openAddSalesmanSheet(root));
  }

  function paintUserList(listEl, users) {
    if (!users.length) {
      listEl.innerHTML = `<div class="empty-state">No salesmen found.</div>`;
      return;
    }
    listEl.innerHTML = users.map((u) => h`
      <a data-link href="/admin/user/${u.id}" class="user-row${u.active ? "" : " inactive"}">
        <div class="avatar">${esc(initials(u.name))}</div>
        <div class="info">
          <div class="name">${esc(u.name)} ${u.active ? "" : '<span class="badge-inactive">Inactive</span>'}</div>
          <div class="mobile">${esc(u.mobile)}</div>
        </div>
        <div class="chevron">&#8250;</div>
      </a>
    `).join("");
  }

  function openAddSalesmanSheet(root) {
    const backdrop = document.createElement("div");
    backdrop.className = "sheet-backdrop";
    backdrop.innerHTML = h`
      <div class="sheet">
        <h3>Add salesman</h3>
        <div class="field"><label>Name</label><input type="text" id="s-name" /></div>
        <div class="field"><label>Mobile number</label><input type="tel" id="s-mobile" inputmode="numeric" /></div>
        <div class="field"><label>Password</label><input type="password" id="s-password" /></div>
        <button class="btn btn-primary" id="s-submit">Create account</button>
      </div>
    `;
    document.body.appendChild(backdrop);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });

    backdrop.querySelector("#s-submit").addEventListener("click", async () => {
      const name = backdrop.querySelector("#s-name").value.trim();
      const mobile = backdrop.querySelector("#s-mobile").value.trim();
      const password = backdrop.querySelector("#s-password").value;
      if (!name || !mobile || !password) return toast("Please fill in every field.");
      const btn = backdrop.querySelector("#s-submit");
      btn.disabled = true;
      btn.textContent = "Creating…";
      try {
        await api("POST", "/api/admin/users", { json: { name, mobile, password } });
        backdrop.remove();
        viewAdmin(ROOT);
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        btn.textContent = "Create account";
      }
    });
  }

  // ---------------------------------------------------------------------
  // Admin — salesman detail
  // ---------------------------------------------------------------------

  async function viewAdminDetail(root, userId) {
    root.innerHTML = `<div class="screen"><p class="muted">Loading…</p></div>`;
    const data = await api("GET", "/api/admin/users/" + userId);
    paintAdminDetail(root, userId, data);
  }

  function paintAdminDetail(root, userId, data) {
    const u = data.user;
    root.innerHTML = h`
      <div class="screen">
        <div class="top-actions">
          <a data-link href="/admin" class="back-btn">&#8592;</a>
        </div>
        <h1>${esc(u.name)}</h1>
        <div class="mono muted" style="margin-top:4px;">${esc(u.mobile)} · ${data.project_count} customer${data.project_count === 1 ? "" : "s"}</div>
        ${u.active ? "" : '<div style="margin-top:8px;"><span class="badge-inactive">Inactive</span></div>'}
        <hr class="divider" />
        ${data.projects.length ? data.projects.map((p) => h`
          <div class="customer-card">
            <div class="top">
              <div>
                <div class="cname">${esc(p.customer_name)}</div>
                <div class="csub">${formatDate(p.created_at)} · ${esc(p.room_type)}</div>
              </div>
            </div>
            <div class="render-thumbs">
              ${p.renders.length ? p.renders.map((r) => `<img src="${r}" />`).join("") : '<span class="muted" style="font-size:12px;">No renders yet</span>'}
            </div>
          </div>
        `).join("") : '<div class="empty-state">No customers yet.</div>'}
        <hr class="divider" />
        <div style="display:flex;flex-direction:column;gap:10px;">
          <button class="btn btn-ghost" id="reset-btn">Reset password</button>
          <button class="btn btn-danger" id="deactivate-btn">${u.active ? "Deactivate" : "Activate"}</button>
        </div>
      </div>
    `;

    root.querySelector("#reset-btn").addEventListener("click", () => openResetPasswordSheet(userId));
    root.querySelector("#deactivate-btn").addEventListener("click", async () => {
      const btn = root.querySelector("#deactivate-btn");
      btn.disabled = true;
      try {
        await api("POST", `/api/admin/users/${userId}/toggle-active`);
        const fresh = await api("GET", "/api/admin/users/" + userId);
        paintAdminDetail(root, userId, fresh);
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    });
  }

  function openResetPasswordSheet(userId) {
    const backdrop = document.createElement("div");
    backdrop.className = "sheet-backdrop";
    backdrop.innerHTML = h`
      <div class="sheet">
        <h3>Reset password</h3>
        <div class="field"><label>New password</label><input type="password" id="r-password" /></div>
        <button class="btn btn-primary" id="r-submit">Save new password</button>
      </div>
    `;
    document.body.appendChild(backdrop);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });

    backdrop.querySelector("#r-submit").addEventListener("click", async () => {
      const password = backdrop.querySelector("#r-password").value;
      if (!password || password.length < 4) return toast("Please choose a longer password.");
      const btn = backdrop.querySelector("#r-submit");
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        await api("POST", `/api/admin/users/${userId}/reset-password`, { json: { password } });
        backdrop.remove();
        toast("Password updated.");
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        btn.textContent = "Save new password";
      }
    });
  }

  // ---------------------------------------------------------------------
  // Admin — generation prompt
  // ---------------------------------------------------------------------

  async function viewAdminPrompt(root) {
    root.innerHTML = `<div class="screen"><p class="muted">Loading…</p></div>`;
    const data = await api("GET", "/api/admin/prompt");
    paintAdminPrompt(root, data);
  }

  function paintAdminPrompt(root, data) {
    root.innerHTML = h`
      <div class="screen">
        <div class="top-actions">
          <a data-link href="/admin" class="back-btn">&#8592;</a>
        </div>
        <div class="eyebrow">Admin</div>
        <h1 style="margin-bottom:4px;">Generation prompt</h1>
        <div class="muted" style="font-size:12.5px;margin-bottom:16px;">
          ${data.updated_at ? "Last saved " + formatDate(data.updated_at) : "Using the built-in default"}
        </div>
        <textarea id="prompt-textarea" class="prompt-textarea" spellcheck="false">${esc(data.prompt)}</textarea>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:14px;">
          <button class="btn btn-primary" id="save-prompt-btn">Save</button>
          <button class="btn btn-ghost" id="reset-prompt-btn">Reset to default</button>
        </div>

        <div class="section-label" style="margin-top:26px;">Image generation settings</div>
        <div class="field">
          <label>Quality</label>
          <select id="quality-select">
            <option value="low" ${data.image_quality === "low" ? "selected" : ""}>Low &mdash; ~$0.005 per image</option>
            <option value="medium" ${data.image_quality === "medium" ? "selected" : ""}>Medium &mdash; ~$0.041 per image</option>
            <option value="high" ${data.image_quality === "high" ? "selected" : ""}>High &mdash; ~$0.165 per image (landscape)</option>
          </select>
        </div>
        <div class="field">
          <label>Output size</label>
          <select id="size-select">
            <option value="auto" ${data.size_mode === "auto" ? "selected" : ""}>Auto &mdash; matches the room photo</option>
            <option value="1024x1024" ${data.size_mode === "1024x1024" ? "selected" : ""}>Square &mdash; 1024&times;1024</option>
            <option value="1024x1536" ${data.size_mode === "1024x1536" ? "selected" : ""}>Portrait &mdash; 1024&times;1536</option>
            <option value="1536x1024" ${data.size_mode === "1536x1024" ? "selected" : ""}>Landscape &mdash; 1536&times;1024</option>
          </select>
        </div>

        <div class="section-label" style="margin-top:26px;">Placeholders you can use</div>
        <div class="placeholder-list">
          ${data.placeholders.map((p) => h`
            <div class="placeholder-item">
              <div class="placeholder-token mono">${esc(p.token)}</div>
              <div class="placeholder-desc">${esc(p.description)}</div>
            </div>
          `).join("")}
        </div>
      </div>
    `;

    root.querySelector("#quality-select").addEventListener("change", async (e) => {
      const value = e.target.value;
      try {
        await api("POST", "/api/admin/settings/image-quality", { json: { value } });
        toast("Quality updated.");
      } catch (err) {
        toast(err.message);
      }
    });

    root.querySelector("#size-select").addEventListener("change", async (e) => {
      const value = e.target.value;
      try {
        await api("POST", "/api/admin/settings/size-mode", { json: { value } });
        toast("Output size updated.");
      } catch (err) {
        toast(err.message);
      }
    });

    root.querySelector("#save-prompt-btn").addEventListener("click", async () => {
      const value = root.querySelector("#prompt-textarea").value;
      const btn = root.querySelector("#save-prompt-btn");
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        const fresh = await api("POST", "/api/admin/prompt", { json: { prompt: value } });
        toast("Prompt saved.");
        paintAdminPrompt(root, fresh);
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        btn.textContent = "Save";
      }
    });

    root.querySelector("#reset-prompt-btn").addEventListener("click", async () => {
      const btn = root.querySelector("#reset-prompt-btn");
      btn.disabled = true;
      btn.textContent = "Resetting…";
      try {
        const fresh = await api("POST", "/api/admin/prompt/reset");
        toast("Reset to the built-in default.");
        paintAdminPrompt(root, fresh);
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        btn.textContent = "Reset to default";
      }
    });
  }

  // ---------------------------------------------------------------------
  // Debug — exactly what was sent to the model for a render
  // ---------------------------------------------------------------------

  const DEBUG_ROLE_LABELS = { room: "Room photo", marked_copy: "Marked copy", product: "Product photo" };

  function formatBytes(n) {
    if (n == null) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  async function viewDebugGeneration(root, renderId) {
    root.innerHTML = `<div class="screen"><p class="muted">Loading…</p></div>`;
    const data = await api("GET", "/api/debug/generation/" + renderId);
    root.innerHTML = h`
      <div class="screen">
        <div class="top-actions">
          <a data-link href="/project/${data.project_id}" class="back-btn">&#8592;</a>
          <div class="eyebrow">Debug &middot; Render #${data.render_id}</div>
        </div>
        <h1 style="margin-bottom:2px;">${esc(data.customer_name || "")}</h1>
        <div class="muted" style="font-size:12.5px;margin-bottom:18px;">${formatDate(data.created_at)}</div>

        <div class="section-label">Resolved prompt</div>
        <textarea class="prompt-textarea" readonly spellcheck="false" style="min-height:32vh;">${esc(data.prompt)}</textarea>

        <div class="section-label" style="margin-top:22px;">Input images, in order sent</div>
        <div class="debug-image-grid">
          ${data.images.map((img, i) => h`
            <div class="debug-image-card">
              <img src="${img.url}" loading="lazy" />
              <div class="debug-image-meta">
                <div class="debug-image-role">${i + 1}. ${esc(DEBUG_ROLE_LABELS[img.role] || img.role)}</div>
                <div class="mono muted" style="font-size:11px;">${img.width}&times;${img.height} &middot; ${formatBytes(img.size_bytes)}</div>
              </div>
            </div>
          `).join("")}
        </div>

        <div class="section-label" style="margin-top:22px;">Output</div>
        <div class="result-image-wrap">
          <img src="${data.output_image_url}" />
        </div>

        <div class="section-label" style="margin-top:22px;">Parameters</div>
        <div class="debug-params">
          <div><span class="mono muted">Model</span><span class="mono">${esc(data.model)}</span></div>
          <div><span class="mono muted">Quality</span><span class="mono">${esc(data.quality)}</span></div>
          <div><span class="mono muted">Size</span><span class="mono">${esc(data.size)}</span></div>
          <div><span class="mono muted">Elapsed</span><span class="mono">${data.elapsed_s.toFixed(1)}s</span></div>
        </div>

        <div class="section-label" style="margin-top:18px;">Usage</div>
        <pre class="debug-usage mono">${esc(JSON.stringify(data.usage, null, 2))}</pre>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  render();
})();
