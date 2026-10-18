/* Firefly 本地博客编辑器 —— 浏览器端逻辑（无框架，无构建） */

const $ = (selector) => document.querySelector(selector);

const STASH_KEY = "firefly-blog-editor:stash";
const DEFAULTS_KEY = "firefly-blog-editor:defaults";

const state = {
	mode: "new", // new | edit
	id: "",
	cover: "",
	images: [],
	posts: [],
	busy: false,
	lockId: false,
	actionsUrl: "",
};

/* ------------------------------------------------------------ 基础工具 */

async function api(path, options = {}) {
	const response = await fetch(path, options);
	let data = null;
	try {
		data = await response.json();
	} catch {
		/* 非 JSON 响应，下面统一报错 */
	}
	if (!response.ok || !data || data.ok === false) {
		throw new Error(
			(data && data.error) || `请求失败（HTTP ${response.status}）`,
		);
	}
	return data;
}

function setStatus(text, kind = "") {
	const element = $("#msg");
	element.textContent = text;
	element.className = `msg ${kind === "ok" ? "status-ok" : kind === "error" ? "status-error" : ""}`;
	element.hidden = !text;
}

function setBusy(busy) {
	state.busy = busy;
	for (const id of ["#btn-save", "#btn-publish", "#btn-upload", "#btn-new"]) {
		const element = $(id);
		if (element) element.disabled = busy;
	}
	renderImages();
}

function showOutput(text) {
	const element = $("#output");
	if (!text) {
		element.hidden = true;
		return;
	}
	element.hidden = false;
	element.textContent = text;
}

function today() {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}

function bytesLabel(bytes) {
	const value = Number(bytes) || 0;
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
	return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function slugify(value) {
	return String(value || "")
		.toLowerCase()
		.replace(/['"]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
}

/* ------------------------------------------------------------ 表单状态 */

function currentId() {
	if (state.mode === "edit") return state.id;
	const date = $("#date").value || today();
	const slug = slugify($("#slug").value);
	return slug ? `${date}-${slug}` : "";
}

function renderFilename() {
	const id = currentId();
	const element = $("#filename");
	if (id) {
		const locked =
			state.lockId || (state.mode === "new" && state.images.length > 0);
		element.textContent = `src/content/posts/${id}.md　（图片放 src/content/posts/${id}/）${
			locked ? "　· 文件名已锁定" : ""
		}`;
	} else {
		element.textContent =
			"还没填文件名：日期 + 英文短横线，例如 2026-10-12-my-first-post";
	}
	const link = $("#preview-link");
	const previewId = state.mode === "edit" ? state.id : id;
	if (previewId) {
		const encoded = previewId.split("/").map(encodeURIComponent).join("/");
		link.href = `http://localhost:4321/posts/${encoded}/`;
		link.removeAttribute("aria-disabled");
	} else {
		link.removeAttribute("href");
	}
}

function updateLockState() {
	const locked =
		state.lockId || (state.mode === "new" && state.images.length > 0);
	$("#slug").disabled = state.mode === "edit" || locked;
	$("#date").disabled = locked;
}

function updateCoverHint() {
	$("#cover-hint").textContent = state.cover
		? `封面：${state.cover}`
		: "封面：未设置（点图片上的「设为封面」）";
}

/* ------------------------------------------------------------ 图片列表 */

function renderImages() {
	const container = $("#images");
	container.textContent = "";
	for (const image of state.images) {
		const card = document.createElement("figure");
		card.className = "image-card";
		if (state.cover === image.link) card.classList.add("is-cover");

		const preview = document.createElement("img");
		preview.src = image.url;
		preview.alt = image.file;
		preview.loading = "lazy";

		const meta = document.createElement("div");
		meta.className = "image-meta";
		const name = document.createElement("span");
		name.textContent = state.cover === image.link ? "封面" : image.file;
		const size = document.createElement("span");
		size.textContent = bytesLabel(image.bytes);
		meta.append(name, size);

		const actions = document.createElement("div");
		actions.className = "image-actions";

		const groupLabel = document.createElement("label");
		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.checked = Boolean(image.checked);
		checkbox.addEventListener("change", () => {
			image.checked = checkbox.checked;
		});
		groupLabel.append(checkbox, document.createTextNode("组图"));

		actions.append(
			groupLabel,
			makeButton("插入", () => {
				const alt = $("#title").value.trim() || "图片";
				insertBlock(`![${alt}](${image.link})`);
			}),
			makeButton("设为封面", () => {
				state.cover = image.link;
				renderImages();
				updateCoverHint();
				onInput();
			}),
			makeButton("删除", () => removeImage(image), "从磁盘删除这张图"),
		);

		card.append(preview, meta, actions);
		container.append(card);
	}
}

function makeButton(label, onClick, title) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	if (title) button.title = title;
	button.disabled = state.busy;
	button.addEventListener("click", onClick);
	return button;
}

async function removeImage(image) {
	if (!window.confirm(`从磁盘删除 ${image.file}？（已写进正文的链接不会自动删）`)) {
		return;
	}
	setBusy(true);
	try {
		await api(
			`/api/post/images?id=${encodeURIComponent(currentId())}&file=${encodeURIComponent(image.file)}`,
			{ method: "DELETE" },
		);
		state.images = state.images.filter((item) => item.file !== image.file);
		if (state.cover === image.link) state.cover = "";
		renderImages();
		updateCoverHint();
		onInput();
		setStatus(`已删除 ${image.file}`, "ok");
	} catch (error) {
		setStatus(error.message, "error");
	} finally {
		setBusy(false);
	}
}

async function uploadFiles(fileList) {
	const files = [...fileList].filter(
		(file) =>
			file.type.startsWith("image/") ||
			/\.(jpe?g|png|webp|avif|heic|heif|gif|bmp|tiff?)$/i.test(file.name),
	);
	if (files.length === 0) return;

	const id = currentId();
	if (!id) {
		setStatus("先把文件名填好（日期 + 英文短横线），再传图片", "error");
		return;
	}

	setBusy(true);
	let done = 0;
	try {
		for (const file of files) {
			done += 1;
			setStatus(`正在处理 ${done}/${files.length}：${file.name}`);
			const response = await fetch(
				`/api/post/images?id=${encodeURIComponent(id)}&name=${encodeURIComponent(file.name)}`,
				{
					method: "POST",
					body: file,
					headers: {
						"content-type": file.type || "application/octet-stream",
					},
				},
			);
			let data = null;
			try {
				data = await response.json();
			} catch {
				/* 交给下面统一报错 */
			}
			if (!response.ok || !data || data.ok === false) {
				throw new Error(
					(data && data.error) || `上传 ${file.name} 失败（HTTP ${response.status}）`,
				);
			}
			state.images.push({ ...data.image, checked: false });
			renderImages();
			updateLockState();
		}
		setStatus(`图片处理完成：${files.length} 张已压成 avif`, "ok");
		onInput();
	} catch (error) {
		setStatus(error.message, "error");
	} finally {
		setBusy(false);
		renderImages();
	}
}

/* ------------------------------------------------------------ 正文插入 */

function insertBlock(text) {
	const area = $("#body");
	const start = area.selectionStart ?? area.value.length;
	const end = area.selectionEnd ?? start;
	const before = area.value.slice(0, start);
	const after = area.value.slice(end);
	const lead =
		before.length === 0 || before.endsWith("\n\n")
			? ""
			: before.endsWith("\n")
				? "\n"
				: "\n\n";
	const trail =
		after.length === 0
			? "\n"
			: after.startsWith("\n\n")
				? ""
				: after.startsWith("\n")
					? "\n"
					: "\n\n";
	const insertion = `${lead}${text}${trail}`;
	area.value = before + insertion + after;
	const caret = start + insertion.length;
	area.selectionStart = caret;
	area.selectionEnd = caret;
	area.focus();
	onInput();
}

function wrapSelection(prefix, suffix, placeholder) {
	const area = $("#body");
	const start = area.selectionStart ?? area.value.length;
	const end = area.selectionEnd ?? start;
	const selected = area.value.slice(start, end) || placeholder;
	const text = `${prefix}${selected}${suffix}`;
	area.value = area.value.slice(0, start) + text + area.value.slice(end);
	area.selectionStart = start + prefix.length;
	area.selectionEnd = start + prefix.length + selected.length;
	area.focus();
	onInput();
}

function insertGrid() {
	const picked = state.images.filter((image) => image.checked);
	const list = picked.length > 0 ? picked : state.images;
	if (list.length === 0) {
		setStatus("还没有图片。先上传，再点「插入组图」", "error");
		return;
	}
	const lines = [
		"[grid]",
		...list.map((image, index) => `![图片${index + 1}](${image.link})`),
		"[/grid]",
	];
	insertBlock(lines.join("\n"));
	setStatus(`已插入 ${list.length} 张图的组图块`, "ok");
}

function handleInsert(kind) {
	if (kind === "grid") {
		insertGrid();
		return;
	}
	if (kind === "tip") {
		insertBlock(":::tip\n提示内容\n:::");
		return;
	}
	if (kind === "code") {
		insertBlock("```js\nconsole.log(\"hello\")\n```");
		return;
	}
	if (kind === "bold") {
		wrapSelection("**", "**", "粗体");
		return;
	}
	if (kind === "link") {
		wrapSelection("[", "](https://)", "链接文字");
	}
}

/* ------------------------------------------------------------ 草稿暂存 */

function snapshot() {
	return {
		at: Date.now(),
		mode: state.mode,
		id: state.id,
		cover: state.cover,
		title: $("#title").value,
		date: $("#date").value,
		slug: $("#slug").value,
		description: $("#description").value,
		tags: $("#tags").value,
		category: $("#category").value,
		draft: $("#draft").checked,
		body: $("#body").value,
		lockId: state.lockId,
	};
}

let stashTimer = null;

function onInput() {
	renderFilename();
	updateLockState();
	if (stashTimer) clearTimeout(stashTimer);
	stashTimer = setTimeout(() => {
		try {
			localStorage.setItem(STASH_KEY, JSON.stringify(snapshot()));
		} catch {
			/* 存不下就算了 */
		}
	}, 400);
}

function clearStash() {
	try {
		localStorage.removeItem(STASH_KEY);
	} catch {
		/* ignore */
	}
}

async function restoreStash() {
	let saved = null;
	try {
		const raw = localStorage.getItem(STASH_KEY);
		if (raw) saved = JSON.parse(raw);
	} catch {
		return false;
	}
	if (!saved) return false;
	const hasContent = Boolean(
		(saved.title && saved.title.trim()) || (saved.body && saved.body.trim()),
	);
	if (!hasContent) return false;

	$("#title").value = saved.title || "";
	$("#date").value = saved.date || today();
	$("#slug").value = saved.slug || "";
	$("#description").value = saved.description || "";
	$("#tags").value = saved.tags || "";
	$("#category").value = saved.category || "";
	$("#draft").checked = saved.draft !== false;
	$("#body").value = saved.body || "";
	state.cover = saved.cover || "";
	state.lockId = Boolean(saved.lockId);

	if (saved.mode === "edit" && saved.id) {
		state.mode = "edit";
		state.id = saved.id;
		try {
			const data = await api(
				`/api/post/images?id=${encodeURIComponent(saved.id)}`,
			);
			state.images = data.images.map((image) => ({
				...image,
				checked: false,
			}));
		} catch {
			state.images = [];
		}
	}
	renderFilename();
	renderImages();
	updateLockState();
	updateCoverHint();
	setStatus("已恢复上次未保存的草稿（保存或发布后自动清除）", "ok");
	return true;
}

/* ------------------------------------------------------------ 保存发布 */

function payload() {
	return {
		id: currentId(),
		title: $("#title").value.trim(),
		date: $("#date").value,
		description: $("#description").value.trim(),
		image: state.cover,
		tags: $("#tags").value,
		category: $("#category").value.trim(),
		draft: $("#draft").checked,
		body: $("#body").value,
	};
}

function rememberDefaults() {
	try {
		localStorage.setItem(
			DEFAULTS_KEY,
			JSON.stringify({
				category: $("#category").value.trim(),
				tags: $("#tags").value,
			}),
		);
	} catch {
		/* ignore */
	}
}

function loadDefaults() {
	try {
		const raw = localStorage.getItem(DEFAULTS_KEY);
		if (!raw) return;
		const saved = JSON.parse(raw);
		if (saved.category) $("#category").value = saved.category;
		if (saved.tags) $("#tags").value = saved.tags;
	} catch {
		/* ignore */
	}
}

async function runLqips() {
	try {
		const data = await api("/api/lqips", { method: "POST" });
		showOutput(`pnpm lqips\n\n${data.output}`);
	} catch (error) {
		showOutput(`pnpm lqips 失败：${error.message}`);
	}
}

async function save(publish) {
	if (state.busy) return;
	const data = payload();
	if (!data.id) {
		setStatus("先把文件名填好（日期 + 英文短横线）", "error");
		return;
	}
	if (!data.title) {
		setStatus("先填标题", "error");
		return;
	}

	setBusy(true);
	setStatus(publish ? "正在提交并推送…" : "正在保存…");
	showOutput("");
	try {
		if (publish) {
			const result = await api("/api/publish", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(data),
			});
			const lines = [];
			if (result.message) lines.push(result.message);
			if (result.changed && result.changed.length > 0) {
				lines.push("", "本次提交的文件：", ...result.changed.map((line) => `  ${line}`));
			}
			if (result.pushError) lines.push("", "push 输出：", result.pushError);
			showOutput(lines.join("\n"));
			setStatus(
				result.pushed
					? "已推送，等 Actions 构建完就能在线看到"
					: result.committed
						? "已本地提交，但推送失败（看下方输出）"
						: result.message || "没有变化",
				result.pushed ? "ok" : result.committed ? "error" : "",
			);
			if (result.committed) {
				state.lockId = true;
				clearStash();
				await loadState();
				await loadPosts();
			}
		} else {
			const result = await api("/api/save", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(data),
			});
			state.lockId = true;
			setStatus(`已保存：${result.saved.file}`, "ok");
			clearStash();
			await loadPosts();
			if ($("#auto-lqip").checked) await runLqips();
		}
		rememberDefaults();
		renderFilename();
		updateLockState();
	} catch (error) {
		setStatus(error.message, "error");
		showOutput(error.message);
	} finally {
		setBusy(false);
	}
}

/* ------------------------------------------------------------ 文章列表 */

async function loadPosts() {
	try {
		const data = await api("/api/posts");
		state.posts = data.posts;
		renderPostList();
	} catch (error) {
		setStatus(error.message, "error");
	}
}

function renderPostList() {
	const container = $("#post-list");
	const filter = $("#post-filter").value.trim().toLowerCase();
	container.textContent = "";
	const posts = state.posts.filter(
		(post) =>
			!filter ||
			post.id.toLowerCase().includes(filter) ||
			post.title.toLowerCase().includes(filter),
	);
	for (const post of posts) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "post-item";
		if (state.mode === "edit" && state.id === post.id) {
			button.classList.add("active");
		}
		const title = document.createElement("span");
		title.className = "post-item-title";
		title.textContent = post.title;
		const meta = document.createElement("span");
		meta.className = "post-item-meta";
		meta.textContent = `${post.date}　${post.id}${post.draft ? "　草稿" : ""}`;
		button.append(title, meta);
		button.addEventListener("click", () => openPost(post.id));
		container.append(button);
	}
	if (posts.length === 0) {
		const empty = document.createElement("div");
		empty.className = "muted";
		empty.textContent = "没有匹配的文章";
		container.append(empty);
	}
}

async function openPost(id) {
	if (state.busy) return;
	setBusy(true);
	setStatus(`正在打开 ${id}…`);
	try {
		const data = await api(`/api/post?id=${encodeURIComponent(id)}`);
		const post = data.post;
		state.mode = "edit";
		state.id = post.id;
		state.cover = post.image;
		state.images = post.images.map((image) => ({ ...image, checked: false }));
		state.lockId = false;

		$("#title").value = post.title;
		$("#date").value = post.date || today();
		const dated = /^\d{4}-\d{2}-\d{2}-(.+)$/.exec(post.id);
		$("#slug").value = dated ? dated[1] : post.id.split("/").pop() || "";
		$("#description").value = post.description;
		$("#tags").value = post.tags.join(", ");
		$("#category").value = post.category;
		$("#draft").checked = post.draft;
		$("#body").value = post.body;

		renderFilename();
		renderImages();
		updateLockState();
		updateCoverHint();
		renderPostList();
		showOutput("");
		setStatus(`已打开：${post.id}`, "ok");
	} catch (error) {
		setStatus(error.message, "error");
	} finally {
		setBusy(false);
	}
}

function newPost() {
	state.mode = "new";
	state.id = "";
	state.cover = "";
	state.images = [];
	state.lockId = false;
	$("#title").value = "";
	$("#date").value = today();
	$("#slug").value = "";
	$("#description").value = "";
	$("#tags").value = "";
	$("#draft").checked = true;
	$("#body").value = "";
	loadDefaults();
	clearStash();
	renderFilename();
	renderImages();
	updateLockState();
	updateCoverHint();
	renderPostList();
	showOutput("");
	setStatus("");
	$("#title").focus();
}

/* ------------------------------------------------------------ 仓库状态 */

async function loadState() {
	try {
		const data = await api("/api/state");
		const dirty = data.dirty.length;
		$("#git-status").textContent = `${data.branch} · 上次提交 ${data.lastCommit || "-"}${
			dirty > 0 ? ` · 另有 ${dirty} 处未提交改动（发布时不会带上）` : ""
		}`;
		if (data.remote) {
			state.actionsUrl = `${data.remote.replace(/\.git$/, "")}/actions`;
			const link = $("#actions-link");
			link.href = state.actionsUrl;
			link.hidden = false;
		}
	} catch (error) {
		$("#git-status").textContent = `读不到 git 状态：${error.message}`;
	}
}

/* ------------------------------------------------------------ 事件绑定 */

function bind() {
	$("#title").addEventListener("input", onInput);
	$("#date").addEventListener("input", onInput);
	$("#description").addEventListener("input", onInput);
	$("#tags").addEventListener("input", onInput);
	$("#category").addEventListener("input", onInput);
	$("#draft").addEventListener("change", onInput);
	$("#body").addEventListener("input", onInput);
	$("#slug").addEventListener("input", () => {
		const input = $("#slug");
		const cleaned = slugify(input.value);
		if (input.value !== cleaned) input.value = cleaned;
		onInput();
	});
	$("#post-filter").addEventListener("input", renderPostList);

	$("#btn-new").addEventListener("click", newPost);
	$("#btn-save").addEventListener("click", () => save(false));
	$("#btn-publish").addEventListener("click", () => save(true));
	$("#btn-upload").addEventListener("click", () => $("#file-input").click());
	$("#file-input").addEventListener("change", (event) => {
		uploadFiles(event.target.files);
		event.target.value = "";
	});

	for (const button of document.querySelectorAll("[data-insert]")) {
		button.addEventListener("click", () => handleInsert(button.dataset.insert));
	}

	const dropzone = $("#dropzone");
	for (const name of ["dragenter", "dragover"]) {
		dropzone.addEventListener(name, (event) => {
			event.preventDefault();
			dropzone.classList.add("dragover");
		});
	}
	for (const name of ["dragleave", "drop"]) {
		dropzone.addEventListener(name, () => dropzone.classList.remove("dragover"));
	}
	dropzone.addEventListener("drop", (event) => {
		event.preventDefault();
		if (event.dataTransfer?.files?.length) uploadFiles(event.dataTransfer.files);
	});

	document.addEventListener("paste", (event) => {
		const files = [...(event.clipboardData?.files || [])];
		if (files.length === 0) return;
		event.preventDefault();
		uploadFiles(files);
	});

	window.addEventListener("beforeunload", () => {
		if (stashTimer) clearTimeout(stashTimer);
		try {
			localStorage.setItem(STASH_KEY, JSON.stringify(snapshot()));
		} catch {
			/* ignore */
		}
	});
}

async function main() {
	bind();
	$("#date").value = today();
	renderFilename();
	updateCoverHint();
	await loadState();
	await loadPosts();
	const restored = await restoreStash();
	if (!restored) loadDefaults();
	renderFilename();
	updateLockState();
}

main();
