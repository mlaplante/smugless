import Sortable from "/vendor/sortable/sortable.esm.js";

// ---------- State ----------

let manifest = null;
let current = null; // selected gallery object
let showAbout = false; // About page editor open instead of a gallery
let selectedPhotoId = null;
let hostingCost;
let saveTimer = null;
let saving = Promise.resolve();

const MAX_BYTES = 100 * 1024 * 1024; // Workers request body limit
const ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/avif"];
const CONFIRM_TIMEOUT_MS = 4000;
const PHOTO_DELETE_CLASS = "photo-delete";
const PHOTO_DRAG_PREVIEW_CLASS = "photo-drag-preview";
const PHOTO_DROP_HIGHLIGHT_CLASS = "photo-drop-highlight";
const GALLERY_ROW_SELECTOR = "#sidebar .gallery-list li[data-slug]";
const DRAG_START_DISTANCE = 4;
const TOUCH_DRAG_DELAY_MS = 180;
const usdFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const gbFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const MIN_DISPLAY_GB = 0.01;
const thumb = (id, w = 400) => `/api/photos/${id}/${w}.webp`;

// ---------- Tiny DOM helper ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

// ---------- Server calls ----------

async function api(path, init) {
  const res = await fetch(path, init);
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("Signed out");
  }
  return res;
}

async function refreshHostingCost() {
  // Keep the editor usable if the R2 estimate takes time or fails.
  try {
    const res = await api("/api/hosting-cost");
    hostingCost = res.ok ? await res.json() : null;
  } catch {
    hostingCost = null;
  }
  renderHostingCost();
}

// ---------- Saving ----------

function setStatus(text, kind = "") {
  const el = document.getElementById("status");
  if (el) {
    el.textContent = text;
    el.className = `status ${kind}`;
  }
}

function scheduleSave() {
  setStatus("Unsaved changes…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

function saveNow() {
  clearTimeout(saveTimer);
  saving = saving.then(async () => {
    setStatus("Saving…");
    const res = await api("/api/manifest", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: res.statusText }));
      setStatus(`Not saved: ${error}`, "error");
      throw new Error(error);
    }
    setStatus("All changes saved", "ok");
  });
  // Keep the chain alive after a failure so later saves still run.
  const result = saving;
  saving = saving.catch(() => {});
  return result;
}

window.addEventListener("beforeunload", (e) => {
  if (document.getElementById("status")?.textContent.startsWith("Unsaved")) e.preventDefault();
});

// ---------- Helpers ----------

function slugify(s) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function uniqueSlug(base, except) {
  base ||= "gallery";
  let slug = base;
  for (let i = 2; manifest.galleries.some((g) => g !== except && g.slug === slug); i++) slug = `${base}-${i}`;
  return slug;
}

// Galleries created in this session whose URL still follows their title.
const autoSlug = new WeakSet();

// Two-click destructive button (no native confirm dialogs).
function confirmButton(label, armedLabel, onConfirm) {
  let timer = null;
  const btn = h(
    "button",
    {
      class: "btn danger",
      onclick: () => {
        if (!timer) {
          btn.textContent = armedLabel;
          btn.classList.add("armed");
          timer = setTimeout(() => {
            timer = null;
            btn.replaceChildren(label);
            btn.classList.remove("armed");
          }, CONFIRM_TIMEOUT_MS);
          return;
        }
        clearTimeout(timer);
        onConfirm();
      },
    },
    label,
  );
  return btn;
}

function selectGallery(g) {
  current = g;
  showAbout = false;
  selectedPhotoId = null;
  history.replaceState(null, "", g ? `#${g.slug}` : "#");
  render();
}

async function deletePhotos(ids) {
  await saveNow(); // the server refuses to delete photos still in the saved manifest
  for (const id of ids) {
    const res = await api(`/api/photos/${id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) setStatus(`Could not delete a photo (${res.status})`, "error");
  }
  if (ids.length) refreshHostingCost();
}

// ---------- Uploads ----------

async function dimensions(file) {
  const bmp = await createImageBitmap(file); // applies EXIF orientation
  const dims = { w: bmp.width, h: bmp.height };
  bmp.close();
  return dims;
}

function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/photos");
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status === 200) resolve(JSON.parse(xhr.responseText));
      else if (xhr.status === 401) location.href = "/login";
      else reject(new Error(JSON.parse(xhr.responseText || "{}").error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(file);
  });
}

async function uploadFiles(files, gallery) {
  files = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const queue = document.getElementById("queue");
  const jobs = files.map((file) => {
    const bar = h("progress", { max: 1, value: 0 });
    const msg = h("span", { class: "queue-msg" }, "waiting");
    const row = h("li", {}, h("span", { class: "queue-name" }, file.name), bar, msg);
    queue?.append(row);
    return { file, row, bar, msg, done: false, photo: null };
  });

  // Append finished uploads to the gallery in the order they were dropped.
  let head = 0;
  const flush = () => {
    let added = false;
    while (head < jobs.length && jobs[head].done) {
      if (jobs[head].photo) {
        gallery.photos.push(jobs[head].photo);
        added = true;
      }
      head++;
    }
    if (added) {
      scheduleSave();
      if (gallery === current) renderPhotos();
      renderSidebar();
    }
  };

  const run = async (job) => {
    const { file } = job;
    try {
      if (!ACCEPTED.includes(file.type)) throw new Error("Use JPEG, PNG, WebP or AVIF");
      if (file.size > MAX_BYTES) throw new Error("Larger than 100 MB");
      job.msg.textContent = "reading";
      const { w, h } = await dimensions(file);
      job.msg.textContent = "uploading";
      const { id } = await uploadFile(file, (p) => (job.bar.value = p));
      job.photo = { id, w, h, filename: file.name };
      job.bar.value = 1;
      job.msg.textContent = "done";
      setTimeout(() => job.row.remove(), 1500);
    } catch (err) {
      job.msg.textContent = err.message;
      job.row.classList.add("failed");
      setTimeout(() => job.row.remove(), 10000);
    }
    job.done = true;
    flush();
  };

  // Three uploads at a time.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, jobs.length) }, async () => {
      while (next < jobs.length) await run(jobs[next++]);
    }),
  );
  if (jobs.some((job) => job.photo)) refreshHostingCost();
}

// ---------- Rendering ----------

function render() {
  const app = document.getElementById("app");
  app.replaceChildren(
    h(
      "header",
      { class: "topbar" },
      h("strong", {}, "smugless"),
      h("span", { id: "status", class: "status ok" }, "All changes saved"),
      h(
        "a",
        { href: showAbout ? "/about" : current ? `/${current.slug}` : "/", target: "_blank", class: "view-link" },
        "View site ↗",
      ),
      h("form", { method: "post", action: "/logout" }, h("button", { class: "link-btn" }, "Log out")),
    ),
    h("aside", { class: "sidebar", id: "sidebar" }),
    h("main", { class: "content", id: "content" }),
  );
  renderSidebar();
  renderContent();
}

function renderSidebar() {
  const side = document.getElementById("sidebar");
  if (!side) return;

  const list = h(
    "ul",
    { class: "gallery-list" },
    manifest.galleries.map((g) =>
      h(
        "li",
        { class: g === current ? "active" : "", "data-slug": g.slug },
        h("span", { class: "drag" }, "⋮⋮"),
        h(
          "button",
          { class: "gallery-btn", onclick: () => selectGallery(g) },
          h("span", { class: "gallery-name" }, g.title),
          h("span", { class: "count" }, String(g.photos.length)),
        ),
      ),
    ),
  );

  Sortable.create(list, {
    handle: ".drag",
    animation: 150,
    onEnd: (e) => {
      const [moved] = manifest.galleries.splice(e.oldIndex, 1);
      manifest.galleries.splice(e.newIndex, 0, moved);
      scheduleSave();
    },
  });

  side.replaceChildren(
    h(
      "section",
      { class: "site-settings" },
      h("h2", {}, "Site"),
      h(
        "label",
        {},
        "Title",
        h("input", {
          value: manifest.site.title,
          oninput: (e) => {
            manifest.site.title = e.target.value;
            scheduleSave();
          },
        }),
      ),
      h(
        "label",
        {},
        "Tagline",
        h("textarea", {
          rows: 2,
          value: manifest.site.tagline ?? "",
          oninput: (e) => {
            manifest.site.tagline = e.target.value;
            scheduleSave();
          },
        }),
      ),
      homePicker(),
      h(
        "div",
        {},
        h(
          "label",
          { class: "checkbox-row" },
          h("input", {
            type: "checkbox",
            checked: manifest.site.limitPublicImages !== false,
            "aria-describedby": "public-photo-size-help",
            onchange: (e) => {
              manifest.site.limitPublicImages = e.target.checked;
              scheduleSave();
            },
          }),
          "Limit public photo size",
        ),
        h(
          "div",
          { class: "muted hint", id: "public-photo-size-help" },
          "Caps the longest side at 1,600 px or 75% of the original, whichever is smaller.",
        ),
      ),
      siteImagePicker("logo", {
        label: "Header logo",
        preview: (logo) => logo && thumb(logo.id),
        emptyText: "Upload logo",
        resetText: "Use site title",
        guidance: "360 × 64 px recommended. The logo fits within 180 × 32 px. Use a transparent PNG.",
      }),
      siteImagePicker("icon", {
        label: "Site icon",
        preview: (icon) => icon
          ? `/icon.png?v=${icon.id}`
          : `/favicon.svg?v=${encodeURIComponent(manifest.site.title.trim().charAt(0))}`,
        emptyText: "Default letter icon · drop a square image to replace",
        resetText: "Use default icon",
      }),
    ),
    h("section", { class: "gallery-section" }, h("h2", {}, "Galleries"), list),
    h(
      "button",
      {
        class: "btn primary",
        onclick: () => {
          const g = { slug: uniqueSlug("untitled"), title: "Untitled", photos: [] };
          autoSlug.add(g);
          manifest.galleries.push(g);
          scheduleSave();
          selectGallery(g);
          document.querySelector(".gallery-form input")?.select();
        },
      },
      "+ New gallery",
    ),
    h("h2", {}, "Pages"),
    h(
      "ul",
      { class: "gallery-list" },
      h(
        "li",
        { class: showAbout ? "active" : "" },
        h(
          "button",
          {
            class: "gallery-btn",
            onclick: () => {
              current = null;
              showAbout = true;
              history.replaceState(null, "", "#about");
              render();
            },
          },
          h("span", { class: "gallery-name" }, "About"),
          h("span", { class: "count" }, manifest.about ? "on" : "off"),
        ),
      ),
    ),
    h(
      "section",
      { "aria-labelledby": "hosting-cost-heading" },
      h("h2", { id: "hosting-cost-heading" }, "Monthly hosting estimate"),
      h("div", { id: "hosting-cost", class: "hosting-cost", "aria-live": "polite" }),
    ),
  );
  renderHostingCost();
}

function renderHostingCost() {
  const panel = document.getElementById("hosting-cost");
  if (!panel) return;

  // Count all active photos. Storage also includes site assets and deleted photos.
  const count = manifest.galleries.reduce((n, g) => n + g.photos.length, manifest.about?.photo ? 1 : 0);
  const photos = `${count.toLocaleString("en-US")} ${count === 1 ? "photo" : "photos"}`;
  if (!hostingCost) {
    panel.replaceChildren(h("span", {}, photos), hostingCost === null ? "Estimate unavailable" : "Calculating…");
    return;
  }

  const gb = hostingCost.storageGB;
  const stored = gb > 0 && gb < MIN_DISPLAY_GB ? `<${MIN_DISPLAY_GB}` : gbFormat.format(gb);
  panel.replaceChildren(
    h("div", {}, h("strong", {}, usdFormat.format(hostingCost.monthlyUSD)), " / month"),
    h("div", {}, `${photos} · ${stored} GB in R2`),
    h("div", { class: "muted" }, "Includes cached copies and trash. Assumes free requests and resizes and the full R2 allowance."),
    h("a", { href: "https://developers.cloudflare.com/r2/pricing/", target: "_blank", rel: "noopener noreferrer" }, "R2 Standard pricing"),
  );
}

// The home page can show the gallery grid or one listed gallery.
function homePicker() {
  return h(
    "label",
    {},
    "Home page",
    h(
      "select",
      {
        onchange: (e) => {
          if (e.target.value) manifest.site.home = e.target.value;
          else delete manifest.site.home;
          scheduleSave();
        },
      },
      h("option", { value: "" }, "Gallery grid"),
      manifest.galleries
        .filter((g) => !g.hidden)
        .map((g) => h("option", { value: g.slug, selected: manifest.site.home === g.slug }, g.title)),
    ),
  );
}

function siteImagePicker(key, { label, preview, emptyText, resetText, guidance }) {
  const asset = manifest.site[key];
  const msg = h("span", { class: "muted" });
  const previewSrc = preview(asset);

  async function saveAsset(next) {
    const old = manifest.site[key];
    if (next) manifest.site[key] = next;
    else delete manifest.site[key];
    // Save the new reference before using it in the preview or removing the old file.
    if (old) await deletePhotos([old.id]);
    else {
      await saveNow();
      refreshHostingCost();
    }
    renderSidebar();
  }

  async function uploadAsset(file) {
    try {
      if (!ACCEPTED.includes(file.type)) throw new Error("Use PNG, JPEG, WebP or AVIF");
      if (file.size > MAX_BYTES) throw new Error("Larger than 100 MB");
      msg.textContent = "Uploading…";
      const { w, h: height } = await dimensions(file);
      const { id } = await uploadFile(file, (p) => (msg.textContent = `Uploading… ${Math.round(p * 100)}%`));
      await saveAsset({ id, w, h: height, filename: file.name });
    } catch (err) {
      msg.textContent = err.message;
    }
  }

  const fileInput = h("input", {
    type: "file",
    accept: ACCEPTED.join(","),
    hidden: true,
    onchange: (e) => {
      if (e.target.files[0]) uploadAsset(e.target.files[0]);
      e.target.value = "";
    },
  });
  const drop = h(
    "button",
    {
      type: "button",
      class: "dropzone site-image-drop",
      "aria-label": `${asset ? "Replace" : "Upload"} ${label.toLowerCase()}`,
      onclick: () => fileInput.click(),
      ondragover: (e) => {
        e.preventDefault();
        drop.classList.add("over");
      },
      ondragleave: () => drop.classList.remove("over"),
      ondrop: (e) => {
        e.preventDefault();
        drop.classList.remove("over");
        if (e.dataTransfer.files[0]) uploadAsset(e.dataTransfer.files[0]);
      },
    },
    previewSrc && h("img", { src: previewSrc, alt: "" }),
    h("span", {}, asset ? "Drop or click to replace" : emptyText),
  );

  return h(
    "div",
    { class: `site-image-field ${key}-field` },
    h("span", { class: "label" }, label),
    drop,
    fileInput,
    guidance && h("span", {}, guidance),
    msg,
    asset
      ? confirmButton(resetText, "Click again to remove", async () => {
          try {
            await saveAsset(null);
          } catch (err) {
            msg.textContent = err.message;
          }
        })
      : null,
  );
}

function renderContent() {
  const content = document.getElementById("content");
  if (showAbout) {
    renderAbout(content);
    return;
  }
  if (!current) {
    content.replaceChildren(
      h(
        "div",
        { class: "empty-state" },
        manifest.galleries.length ? "Pick a gallery on the left." : "Create your first gallery to get started.",
      ),
    );
    return;
  }
  const g = current;

  const slugError = h("span", { class: "field-error" });
  const setSlug = (v) => {
    if (manifest.site.home === g.slug) manifest.site.home = v;
    g.slug = v;
    history.replaceState(null, "", `#${v}`);
    document.querySelector(".view-link").href = `/${v}`;
    slugError.textContent = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(v) ? "" : "Lowercase letters, numbers and dashes";
  };
  const slugInput = h("input", {
    value: g.slug,
    onchange: renderSidebar,
    oninput: (e) => {
      const v = e.target.value.toLowerCase();
      e.target.value = v;
      autoSlug.delete(g);
      setSlug(v);
      scheduleSave();
    },
  });
  const form = h(
    "section",
    { class: "gallery-form" },
    h(
      "div",
      { class: "row" },
      h(
        "label",
        { class: "grow" },
        "Title",
        h("input", {
          value: g.title,
          onchange: renderSidebar,
          oninput: (e) => {
            g.title = e.target.value;
            const btn = document.querySelector(`.gallery-list li.active .gallery-name`);
            if (btn) btn.textContent = g.title;
            if (autoSlug.has(g)) {
              setSlug(uniqueSlug(slugify(g.title) || "untitled", g));
              slugInput.value = g.slug;
            }
            scheduleSave();
          },
        }),
      ),
      h("label", {}, "URL", h("span", { class: "slug-input" }, "/", slugInput)),
    ),
    slugError,
    h(
      "label",
      {},
      "Description",
      h("textarea", {
        rows: 3,
        value: g.description ?? "",
        oninput: (e) => {
          g.description = e.target.value;
          scheduleSave();
        },
      }),
    ),
    h(
      "label",
      { class: "checkbox-row" },
      h("input", {
        type: "checkbox",
        checked: g.hidden === true,
        onchange: (e) => {
          g.hidden = e.target.checked;
          // Return to the grid if the home page used this gallery.
          if (g.hidden && manifest.site.home === g.slug) delete manifest.site.home;
          renderSidebar();
          scheduleSave();
        },
      }),
      "Hide from public lists",
    ),
    h(
      "div",
      { class: "row end" },
      confirmButton(
        "Delete gallery",
        g.photos.length
          ? `Delete it and its ${g.photos.length} photo${g.photos.length === 1 ? "" : "s"}? Click again`
          : "Click again to delete",
        async () => {
          const ids = g.photos.map((p) => p.id);
          manifest.galleries = manifest.galleries.filter((x) => x !== g);
          if (manifest.site.home === g.slug) delete manifest.site.home;
          selectGallery(manifest.galleries[0] ?? null);
          await deletePhotos(ids);
        },
      ),
    ),
  );

  const fileInput = h("input", {
    type: "file",
    multiple: true,
    accept: ACCEPTED.join(","),
    hidden: true,
    onchange: (e) => {
      uploadFiles(e.target.files, g);
      e.target.value = "";
    },
  });
  const drop = h(
    "div",
    {
      class: "dropzone",
      onclick: () => fileInput.click(),
      ondragover: (e) => {
        e.preventDefault();
        drop.classList.add("over");
      },
      ondragleave: () => drop.classList.remove("over"),
      ondrop: (e) => {
        e.preventDefault();
        drop.classList.remove("over");
        uploadFiles(e.dataTransfer.files, g);
      },
    },
    h("strong", {}, "Drop photos here"),
    h("span", {}, "or click to choose · JPEG, PNG, WebP, AVIF up to 100 MB"),
    fileInput,
  );

  content.replaceChildren(
    form,
    drop,
    h("ul", { class: "queue", id: "queue" }),
    h("div", { class: "photos-layout" }, h("div", { id: "photos" }), h("aside", { id: "photo-panel" })),
  );
  renderPhotos();
}

function renderPhotos() {
  const wrap = document.getElementById("photos");
  if (!wrap || !current) return;
  const g = current;

  if (!g.photos.length) {
    wrap.replaceChildren(h("p", { class: "muted" }, "No photos yet."));
    renderPanel();
    return;
  }

  const grid = h(
    "ul",
    { class: "photo-grid" },
    g.photos.map((p) => {
      const remove = confirmButton(
        h("span", { role: "img", "aria-label": `Delete ${p.filename}` }, "×"),
        "Confirm delete",
        async () => {
          g.photos = g.photos.filter((x) => x !== p);
          if (g.cover === p.id) delete g.cover;
          if (selectedPhotoId === p.id) selectedPhotoId = null;
          renderSidebar();
          renderPhotos();
          await deletePhotos([p.id]);
        },
      );
      remove.classList.add(PHOTO_DELETE_CLASS);
      remove.addEventListener("click", (e) => e.stopPropagation());

      return h(
        "li",
        {
          class: [p.id === selectedPhotoId && "selected", p.id === (g.cover ?? g.photos[0]?.id) && "cover"]
            .filter(Boolean)
            .join(" "),
          "data-id": p.id,
          onclick: () => {
            selectedPhotoId = p.id;
            grid.querySelectorAll("li").forEach((li) => li.classList.toggle("selected", li.dataset.id === p.id));
            renderPanel();
          },
        },
        h("img", { src: thumb(p.id), alt: p.filename, loading: "lazy", draggable: "false" }),
        p.caption ? h("span", { class: "cap" }, p.caption) : null,
        remove,
      );
    }),
  );

  let highlightedGallery = null;
  const elementAtPointer = (e) => {
    const point = e.changedTouches?.[0] ?? e;
    return document.elementFromPoint(point.clientX, point.clientY);
  };
  const highlightGallery = (e) => {
    const row = elementAtPointer(e)?.closest(GALLERY_ROW_SELECTOR);
    const target = row && row.dataset.slug !== g.slug ? row : null;
    if (target === highlightedGallery) return;
    highlightedGallery?.classList.remove(PHOTO_DROP_HIGHLIGHT_CLASS);
    highlightedGallery = target;
    highlightedGallery?.classList.add(PHOTO_DROP_HIGHLIGHT_CLASS);
  };

  const photoSort = Sortable.create(grid, {
    animation: 150,
    // Use the same pointer coordinates for sorting and dropping onto the sidebar.
    forceFallback: true,
    fallbackOnBody: true,
    fallbackClass: PHOTO_DRAG_PREVIEW_CLASS,
    fallbackTolerance: DRAG_START_DISTANCE,
    supportPointer: false,
    delay: TOUCH_DRAG_DELAY_MS,
    delayOnTouchOnly: true,
    touchStartThreshold: DRAG_START_DISTANCE,
    // Let the delete button receive focus without starting a drag.
    filter: `.${PHOTO_DELETE_CLASS}`,
    preventOnFilter: false,
    onStart: (e) => {
      document.addEventListener("mousemove", highlightGallery);
      document.addEventListener("touchmove", highlightGallery, { passive: true });
      highlightGallery(e.originalEvent);
    },
    onEnd: (e) => {
      document.removeEventListener("mousemove", highlightGallery);
      document.removeEventListener("touchmove", highlightGallery);
      highlightedGallery?.classList.remove(PHOTO_DROP_HIGHLIGHT_CLASS);
      highlightedGallery = null;

      const pointer = e.originalEvent;
      const drop = pointer.type === "touchcancel" ? null : elementAtPointer(pointer);
      const row = drop?.closest(GALLERY_ROW_SELECTOR);
      const target = manifest.galleries.find((gallery) => gallery.slug === row?.dataset.slug);
      if (target && target !== g) {
        // The photo may have shifted in the grid during the drag. Move it by ID.
        const index = g.photos.findIndex((p) => p.id === e.item.dataset.id);
        if (index === -1) return;
        const [photo] = g.photos.splice(index, 1);
        target.photos.push(photo);
        if (g.cover === photo.id) delete g.cover;
        if (selectedPhotoId === photo.id) selectedPhotoId = null;
        scheduleSave();
        renderSidebar();
        renderPhotos();
        return;
      }

      if (e.oldIndex === e.newIndex) return;
      if (!drop || !grid.contains(drop)) {
        photoSort.sort(g.photos.map((p) => p.id));
        return;
      }
      const [moved] = g.photos.splice(e.oldIndex, 1);
      g.photos.splice(e.newIndex, 0, moved);
      scheduleSave();
      if (!g.cover) renderPhotos(); // first photo is the implicit cover
    },
  });

  const moveHint = manifest.galleries.length > 1 ? " · drop on a gallery to move" : "";
  wrap.replaceChildren(
    h(
      "p",
      { class: "muted hint" },
      `${g.photos.length} photo${g.photos.length === 1 ? "" : "s"} · drag to reorder${moveHint} · click to edit`,
    ),
    grid,
  );
  renderPanel();
}

function renderPanel() {
  const panel = document.getElementById("photo-panel");
  if (!panel) return;
  const g = current;
  const p = g?.photos.find((x) => x.id === selectedPhotoId);
  if (!p) {
    panel.replaceChildren();
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const isCover = (g.cover ?? g.photos[0]?.id) === p.id;

  panel.replaceChildren(
    h("img", { src: thumb(p.id, 800), alt: p.filename }),
    h("p", { class: "meta" }, p.filename, h("br"), `${p.w} × ${p.h}`),
    h(
      "label",
      {},
      "Caption",
      h("textarea", {
        rows: 3,
        value: p.caption ?? "",
        oninput: (e) => {
          p.caption = e.target.value;
          const li = document.querySelector(`.photo-grid li[data-id="${p.id}"]`);
          let cap = li?.querySelector(".cap");
          if (li && !cap) li.append((cap = h("span", { class: "cap" })));
          if (cap) cap.textContent = p.caption;
          scheduleSave();
        },
      }),
    ),
    h(
      "button",
      {
        class: "btn",
        disabled: isCover,
        onclick: () => {
          g.cover = p.id;
          scheduleSave();
          renderPhotos();
        },
      },
      isCover ? "Gallery cover" : "Use as gallery cover",
    ),
  );
}

// ---------- About page ----------

function renderAbout(content) {
  const a = manifest.about;
  if (!a) {
    content.replaceChildren(
      h(
        "div",
        { class: "empty-state" },
        h("p", {}, "No About page yet. It appears at /about, last in the navigation."),
        h(
          "button",
          {
            class: "btn primary",
            onclick: () => {
              manifest.about = { title: "About", text: "" };
              scheduleSave();
              render();
            },
          },
          "Add an About page",
        ),
      ),
    );
    return;
  }

  const field = (label, key, props = {}) =>
    h(
      "label",
      {},
      label,
      h(props.rows ? "textarea" : "input", {
        ...props,
        value: a[key] ?? "",
        oninput: (e) => {
          a[key] = e.target.value;
          scheduleSave();
        },
      }),
    );

  const fileInput = h("input", {
    type: "file",
    accept: ACCEPTED.join(","),
    hidden: true,
    onchange: (e) => {
      if (e.target.files[0]) setPortrait(e.target.files[0]);
      e.target.value = "";
    },
  });
  const portraitMsg = h("span", { class: "muted" });

  async function setPortrait(file) {
    try {
      if (!ACCEPTED.includes(file.type)) throw new Error("Use JPEG, PNG, WebP or AVIF");
      if (file.size > MAX_BYTES) throw new Error("Larger than 100 MB");
      portraitMsg.textContent = "Uploading…";
      const { w, h: height } = await dimensions(file);
      const { id } = await uploadFile(file, (p) => (portraitMsg.textContent = `Uploading… ${Math.round(p * 100)}%`));
      const old = a.photo;
      a.photo = { id, w, h: height, filename: file.name, ...(old?.caption ? { caption: old.caption } : {}) };
      renderAbout(content);
      if (old) await deletePhotos([old.id]);
      else {
        await saveNow();
        refreshHostingCost();
      }
    } catch (err) {
      portraitMsg.textContent = err.message;
    }
  }

  const drop = h(
    "div",
    {
      class: "dropzone portrait-drop",
      onclick: () => fileInput.click(),
      ondragover: (e) => {
        e.preventDefault();
        drop.classList.add("over");
      },
      ondragleave: () => drop.classList.remove("over"),
      ondrop: (e) => {
        e.preventDefault();
        drop.classList.remove("over");
        if (e.dataTransfer.files[0]) setPortrait(e.dataTransfer.files[0]);
      },
    },
    a.photo ? h("img", { src: thumb(a.photo.id, 800), alt: "" }) : h("strong", {}, "Drop a portrait here"),
    h("span", {}, a.photo ? "Drop or click to replace" : "or click to choose"),
    fileInput,
  );

  content.replaceChildren(
    h(
      "section",
      { class: "gallery-form about-form" },
      field("Title", "title"),
      field("Text", "text", { rows: 12, placeholder: "Separate paragraphs with a blank line." }),
      field("Contact email", "email", { type: "email", placeholder: "Optional" }),
      h("h3", {}, "Portrait"),
      drop,
      portraitMsg,
      a.photo
        ? h(
            "label",
            {},
            "Portrait description (for screen readers)",
            h("input", {
              value: a.photo.caption ?? "",
              placeholder: "e.g. Me with my camera on the beach",
              oninput: (e) => {
                a.photo.caption = e.target.value;
                scheduleSave();
              },
            }),
          )
        : null,
      h(
        "div",
        { class: "row end" },
        a.photo
          ? confirmButton("Remove portrait", "Click again to remove", async () => {
              const id = a.photo.id;
              delete a.photo;
              renderAbout(content);
              await deletePhotos([id]);
            })
          : null,
        confirmButton("Delete About page", "Click again to delete", async () => {
          const ids = a.photo ? [a.photo.id] : [];
          delete manifest.about;
          render();
          await deletePhotos(ids);
        }),
      ),
    ),
  );
}

// ---------- Boot ----------

async function boot() {
  const res = await api("/api/manifest");
  if (!res.ok) {
    document.getElementById("app").textContent = `Could not load: HTTP ${res.status}`;
    return;
  }
  manifest = await res.json();
  const slug = decodeURIComponent(location.hash.slice(1));
  showAbout = slug === "about";
  if (!showAbout) current = manifest.galleries.find((g) => g.slug === slug) ?? manifest.galleries[0] ?? null;
  render();
  refreshHostingCost();
}

boot();
