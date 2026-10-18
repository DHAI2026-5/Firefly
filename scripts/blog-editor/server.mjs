/*
 * Firefly 本地博客编辑器 —— 只监听 127.0.0.1，不对外暴露。
 *
 *   pnpm blog        →  http://127.0.0.1:4322
 *
 * 它只会写三种东西：
 *   1. src/content/posts/<id>.md
 *   2. src/content/posts/<id>/<n>.avif
 *   3. 一次 git commit（只提交上面这两个路径）
 */

import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const POSTS_DIR = path.join(ROOT, "src", "content", "posts");

const HOST = "127.0.0.1";
const PORT = Number(process.env.BLOG_EDITOR_PORT || 4322);

const IMAGE_MAX_SIDE = 1600;
const AVIF_QUALITY = 80;
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

const POST_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})-/;
const IMAGE_FILE_RE = /^\d+\.(?:avif|webp|jpe?g|png)$/i;
const MD_EXT_RE = /\.(md|mdx)$/i;

const STATIC_FILES = new Map([
	["/", ["index.html", "text/html; charset=utf-8"]],
	["/index.html", ["index.html", "text/html; charset=utf-8"]],
	["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
	["/app.css", ["app.css", "text/css; charset=utf-8"]],
]);

const MEDIA_TYPES = new Map([
	["avif", "image/avif"],
	["webp", "image/webp"],
	["jpg", "image/jpeg"],
	["jpeg", "image/jpeg"],
	["png", "image/png"],
]);

/* ------------------------------------------------------------------ 小工具 */

function sendJSON(res, status, data) {
	const body = Buffer.from(JSON.stringify(data), "utf8");
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": body.length,
		"cache-control": "no-store",
	});
	res.end(body);
}

function sendError(res, status, message) {
	sendJSON(res, status, { ok: false, error: message });
}

function describeError(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}

function safeDecode(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error(`请求体超过 ${Math.round(limit / 1024 / 1024)}MB 上限`));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

async function readJSON(req) {
	const buffer = await readBody(req, MAX_JSON_BYTES);
	if (buffer.length === 0) return {};
	try {
		return JSON.parse(buffer.toString("utf8"));
	} catch {
		throw new Error("请求内容不是合法 JSON");
	}
}

async function exists(target) {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

async function isDirectory(target) {
	try {
		const info = await stat(target);
		return info.isDirectory();
	} catch {
		return false;
	}
}

function toRelative(target) {
	return path.relative(ROOT, target).split(path.sep).join("/");
}

function today() {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}

/* -------------------------------------------------------------- 文章路径 */

/** 把 id 解析成 md 文件路径，同时挡掉路径穿越 */
function resolvePostPath(id) {
	const raw = String(id || "").trim();
	if (!raw) throw new Error("缺少文章 id");
	if (raw.includes("..") || raw.startsWith("/") || raw.includes("\\")) {
		throw new Error("文章 id 不合法");
	}
	const target = path.resolve(POSTS_DIR, `${raw}.md`);
	if (!target.startsWith(`${POSTS_DIR}${path.sep}`)) {
		throw new Error("文章 id 超出 posts 目录");
	}
	return target;
}

/** 新建文章必须是「日期-英文短横线」 */
function assertNewPostId(id) {
	const raw = String(id || "").trim();
	if (!POST_ID_RE.test(raw)) {
		throw new Error(
			"新文件名必须是「日期-英文短横线」，例如 2026-10-12-my-first-post",
		);
	}
	return raw;
}

function normalizeId(value) {
	return String(value || "").trim().replace(/^\/+|\/+$/g, "");
}

/** 图片在 markdown 里的相对链接（相对 md 文件所在目录） */
function relativeImageUrl(mdPath, imagePath) {
	let relative = path
		.relative(path.dirname(mdPath), imagePath)
		.split(path.sep)
		.join("/");
	if (!relative.startsWith(".")) relative = `./${relative}`;
	return relative;
}

/* ------------------------------------------------------- frontmatter 处理 */

// 本工具负责维护的字段，其余字段（lang、pinned、password…）原样保留
const MANAGED_KEYS = [
	"title",
	"published",
	"updated",
	"description",
	"image",
	"tags",
	"category",
	"draft",
];

/** Windows 编辑器可能给文件加 BOM，解析前先去掉，否则 frontmatter 会整个解析失败 */
function stripBom(text) {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function splitFrontmatter(raw) {
	const text = stripBom(raw);
	const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
	if (!match) return { entries: [], body: text };
	return { entries: parseEntries(match[1]), body: text.slice(match[0].length) };
}

function parseEntries(raw) {
	const entries = [];
	for (const line of raw.split(/\r?\n/)) {
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		const keyMatch = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
		if (keyMatch) {
			entries.push({ key: keyMatch[1], lines: [line] });
		} else if (entries.length > 0) {
			// 块状数组 / 换行续写，接到上一条后面
			entries[entries.length - 1].lines.push(line);
		}
	}
	return entries;
}

function entryRawValue(entry) {
	const text = entry.lines.join("\n");
	return text.slice(text.indexOf(":") + 1).trim();
}

function unquote(value) {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	if (first === '"' && last === '"') {
		return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
	}
	if (first === "'" && last === "'") {
		return trimmed.slice(1, -1).replace(/''/g, "'");
	}
	return trimmed;
}

function findEntry(entries, key) {
	return entries.find((entry) => entry.key === key);
}

function readString(entries, key) {
	const entry = findEntry(entries, key);
	return entry ? unquote(entryRawValue(entry)) : "";
}

function readTags(entries) {
	const entry = findEntry(entries, "tags");
	if (!entry) return [];
	const inline = entryRawValue(entry);
	if (inline.startsWith("[")) {
		return inline
			.slice(1, inline.endsWith("]") ? -1 : undefined)
			.split(",")
			.map((item) => unquote(item).trim())
			.filter(Boolean);
	}
	return entry.lines
		.slice(1)
		.map((line) => line.replace(/^\s*-\s*/, "").trim())
		.map(unquote)
		.filter(Boolean);
}

function readBoolean(entries, key) {
	return /^true$/i.test(readString(entries, key));
}

/** published 可能写成 2026-10-12，也可能是完整 ISO 时间 */
function readDate(entries, key) {
	const value = readString(entries, key);
	const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
	return match ? match[0] : "";
}

function yamlString(value) {
	return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlSingleQuoted(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

function buildFrontmatter(entries, data) {
	const managed = new Map();
	managed.set("title", `title: ${yamlString(data.title)}`);
	managed.set("published", `published: ${data.date}`);
	if (data.updated) managed.set("updated", `updated: ${data.updated}`);
	managed.set(
		"description",
		`description: ${data.description ? yamlString(data.description) : "''"}`,
	);
	managed.set(
		"image",
		`image: ${data.image ? yamlSingleQuoted(data.image) : "''"}`,
	);
	managed.set("tags", `tags: [${data.tags.map(yamlString).join(", ")}]`);
	managed.set(
		"category",
		`category: ${data.category ? yamlString(data.category) : "''"}`,
	);
	managed.set("draft", `draft: ${data.draft ? "true" : "false"}`);

	const lines = [];
	const written = new Set();
	for (const entry of entries) {
		if (managed.has(entry.key)) {
			if (!written.has(entry.key)) {
				lines.push(managed.get(entry.key));
				written.add(entry.key);
			}
			continue;
		}
		lines.push(...entry.lines);
	}
	for (const key of MANAGED_KEYS) {
		if (managed.has(key) && !written.has(key)) lines.push(managed.get(key));
	}
	return lines.join("\n");
}

function composeFile(entries, data, body) {
	const frontmatter = buildFrontmatter(entries, data);
	const cleanBody = String(body || "")
		.replace(/\r\n/g, "\n")
		.replace(/^\n+/, "")
		.replace(/\s+$/, "");
	return `---\n${frontmatter}\n---\n\n${cleanBody}\n`;
}

/* ---------------------------------------------------------------- 文章读写 */

function normalizeTags(input) {
	const list = Array.isArray(input)
		? input
		: String(input || "").split(/[,，、]/g);
	const seen = new Set();
	const tags = [];
	for (const item of list) {
		const tag = String(item).trim();
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		tags.push(tag);
	}
	return tags;
}

function pickDate(id, requested) {
	const requestedDate = String(requested || "").trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) return requestedDate;
	const prefix = DATE_PREFIX_RE.exec(id);
	return prefix ? prefix[1] : today();
}

async function savePost(payload) {
	const id = normalizeId(payload.id);
	const mdPath = resolvePostPath(id);
	const existed = await exists(mdPath);
	const entries = existed
		? splitFrontmatter(await readFile(mdPath, "utf8")).entries
		: [];

	const data = {
		title: String(payload.title || "").trim() || "未命名",
		date: pickDate(id, payload.date),
		updated: existed ? today() : "",
		description: String(payload.description || "").trim(),
		image: String(payload.image || "").trim(),
		tags: normalizeTags(payload.tags),
		category: String(payload.category || "").trim(),
		draft: Boolean(payload.draft),
	};

	const content = composeFile(entries, data, payload.body);
	await mkdir(path.dirname(mdPath), { recursive: true });
	await writeFile(mdPath, content, "utf8");

	return { id, file: toRelative(mdPath), created: !existed, title: data.title };
}

async function listPostFiles(dir = POSTS_DIR, prefix = "", depth = 0) {
	if (depth > 1) return [];
	const items = await readdir(dir, { withFileTypes: true });
	const files = [];
	for (const item of items) {
		const relative = prefix ? `${prefix}/${item.name}` : item.name;
		if (item.isDirectory()) {
			if (depth === 0 && !prefix) {
				files.push(...(await listPostFiles(path.join(dir, item.name), item.name, depth + 1)));
			}
			continue;
		}
		if (!MD_EXT_RE.test(item.name)) continue;
		files.push({ id: relative.replace(MD_EXT_RE, ""), file: path.join(dir, item.name) });
	}
	return files;
}

async function listPosts() {
	const files = await listPostFiles();
	const posts = [];
	for (const item of files) {
		try {
			const raw = await readFile(item.file, "utf8");
			const { entries } = splitFrontmatter(raw);
			posts.push({
				id: item.id,
				title: readString(entries, "title") || item.id,
				date: readDate(entries, "published") || "1970-01-01",
				draft: readBoolean(entries, "draft"),
			});
		} catch {
			posts.push({ id: item.id, title: item.id, date: "1970-01-01", draft: false });
		}
	}
	posts.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
	return posts;
}

async function listImages(id) {
	const dir = path.join(POSTS_DIR, normalizeId(id));
	if (!(await isDirectory(dir))) return [];
	const names = await readdir(dir);
	const mdPath = resolvePostPath(id);
	const images = [];
	for (const name of names) {
		if (!IMAGE_FILE_RE.test(name)) continue;
		const full = path.join(dir, name);
		const info = await stat(full);
		images.push({
			file: name,
			url: `/media/${encodeURIComponent(normalizeId(id))}/${encodeURIComponent(name)}`,
			link: relativeImageUrl(mdPath, full),
			bytes: info.size,
		});
	}
	images.sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }));
	return images;
}

async function loadPost(id) {
	const normalized = normalizeId(id);
	const mdPath = resolvePostPath(normalized);
	if (!(await exists(mdPath))) throw new Error(`找不到文章 ${normalized}`);
	const raw = await readFile(mdPath, "utf8");
	const { entries, body } = splitFrontmatter(raw);
	return {
		id: normalized,
		title: readString(entries, "title"),
		date: readDate(entries, "published"),
		description: readString(entries, "description"),
		image: readString(entries, "image"),
		tags: readTags(entries),
		category: readString(entries, "category"),
		draft: readBoolean(entries, "draft"),
		body: body.replace(/^\n+/, ""),
		images: await listImages(normalized),
	};
}

/* ------------------------------------------------------------------- 图片 */

let sharpModule = null;

async function getSharp() {
	if (sharpModule) return sharpModule;
	try {
		const imported = await import("sharp");
		sharpModule = imported.default;
	} catch {
		throw new Error("没有找到 sharp，请先在仓库根目录跑一次 pnpm install");
	}
	return sharpModule;
}

async function nextImageIndex(dir) {
	if (!(await isDirectory(dir))) return 1;
	const names = await readdir(dir);
	let max = 0;
	for (const name of names) {
		if (!IMAGE_FILE_RE.test(name)) continue;
		const index = Number.parseInt(name, 10);
		if (Number.isFinite(index) && index > max) max = index;
	}
	return max + 1;
}

async function saveImage(id, buffer, originalName) {
	if (buffer.length === 0) throw new Error("图片是空的");
	if (buffer.length > MAX_UPLOAD_BYTES) throw new Error("单张图片超过 60MB");

	const normalized = normalizeId(id);
	const mdPath = resolvePostPath(normalized);
	const sharp = await getSharp();
	const dir = path.join(POSTS_DIR, normalized);
	await mkdir(dir, { recursive: true });

	let encoded;
	try {
		encoded = await sharp(buffer, { failOn: "none", limitInputPixels: 268402689 })
			.rotate()
			.resize({
				width: IMAGE_MAX_SIDE,
				height: IMAGE_MAX_SIDE,
				fit: "inside",
				withoutEnlargement: true,
			})
			.avif({ quality: AVIF_QUALITY, effort: 4 })
			.toBuffer();
	} catch (error) {
		throw new Error(`这个文件处理不了（不是图片？）：${describeError(error)}`);
	}

	const index = await nextImageIndex(dir);
	const name = `${index}.avif`;
	const target = path.join(dir, name);
	await writeFile(target, encoded);
	const meta = await sharp(encoded).metadata();

	return {
		file: name,
		url: `/media/${encodeURIComponent(normalized)}/${encodeURIComponent(name)}`,
		link: relativeImageUrl(mdPath, target),
		bytes: encoded.length,
		width: meta.width || 0,
		height: meta.height || 0,
		original: String(originalName || "").slice(0, 200),
	};
}

async function deleteImage(id, file) {
	if (!IMAGE_FILE_RE.test(String(file || ""))) throw new Error("图片名不合法");
	const target = path.join(POSTS_DIR, normalizeId(id), path.basename(String(file)));
	if (!target.startsWith(`${POSTS_DIR}${path.sep}`)) throw new Error("图片路径越界");
	if (!(await exists(target))) throw new Error("图片不存在");
	await rm(target);
	return { file: String(file) };
}

/* -------------------------------------------------------------------- git */

function git(args) {
	return new Promise((resolve) => {
		execFile(
			"git",
			args,
			{ cwd: ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout, stderr) => {
				resolve({
					code: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
					stdout: String(stdout || "").trim(),
					stderr: String(stderr || "").trim(),
				});
			},
		);
	});
}

async function getState() {
	const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
	const log = await git(["log", "-1", "--pretty=%h %s"]);
	const status = await git(["status", "--porcelain"]);
	const remote = await git(["remote", "get-url", "origin"]);
	return {
		ok: true,
		root: ROOT,
		branch: branch.stdout || "master",
		remote: remote.stdout,
		lastCommit: log.stdout,
		dirty: status.stdout ? status.stdout.split(/\r?\n/).filter(Boolean) : [],
	};
}

function commitMessage(created, title) {
	return `content: ${created ? "新增" : "更新"}文章《${title}》`;
}

async function publishPost(payload) {
	const saved = await savePost(payload);
	const id = normalizeId(payload.id);
	const paths = [saved.file];
	const imageDir = path.join(POSTS_DIR, id);
	if (await isDirectory(imageDir)) paths.push(toRelative(imageDir));

	const add = await git(["add", "--", ...paths]);
	if (add.code !== 0) throw new Error(`git add 失败：${add.stderr || add.stdout}`);

	// 只看这几个路径有没有变化，你其它暂存的东西不会被带上
	const status = await git(["status", "--porcelain", "--", ...paths]);
	const changed = status.stdout ? status.stdout.split(/\r?\n/).filter(Boolean) : [];
	if (changed.length === 0) {
		return {
			ok: true,
			saved,
			committed: false,
			pushed: false,
			message: "内容和上次完全一样，没有产生提交",
			changed: [],
		};
	}

	const commit = await git([
		"commit",
		"-m",
		commitMessage(saved.created, saved.title),
		"--",
		...paths,
	]);
	if (commit.code !== 0) {
		throw new Error(`git commit 失败：\n${commit.stderr || commit.stdout}`);
	}
	const sha = (await git(["rev-parse", "--short", "HEAD"])).stdout;
	const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout || "master";

	const push = await git(["push", "origin", branch]);
	const pushed = push.code === 0;
	return {
		ok: true,
		saved,
		committed: true,
		pushed,
		sha,
		branch,
		changed,
		message: pushed
			? `已提交并推送到 origin/${branch}（${sha}）`
			: `已提交（${sha}），但推送失败，请检查网络或凭据`,
		pushError: pushed ? "" : push.stderr || push.stdout,
	};
}

function runCommand(command, args, timeoutMs = 180000) {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: ROOT,
			shell: process.platform === "win32",
			windowsHide: true,
			env: { ...process.env, FORCE_COLOR: "0" },
		});
		let output = "";
		const timer = setTimeout(() => {
			child.kill();
			resolve({ code: -1, output: `${output}\n（超时已中断）` });
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: 1, output: `${output}\n${describeError(error)}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code || 0, output });
		});
	});
}

/* ----------------------------------------------------------------- 路由 */

async function sendStatic(res, entry) {
	const [fileName, contentType] = entry;
	const buffer = await readFile(path.join(HERE, fileName));
	res.writeHead(200, {
		"content-type": contentType,
		"content-length": buffer.length,
		"cache-control": "no-store",
	});
	res.end(buffer);
}

async function sendMedia(res, rest) {
	const parts = safeDecode(rest).split("/");
	const fileName = parts.pop() || "";
	const id = parts.join("/");
	if (!IMAGE_FILE_RE.test(fileName) || !id) {
		sendError(res, 400, "图片路径不合法");
		return;
	}
	const target = path.join(POSTS_DIR, id, fileName);
	if (!target.startsWith(`${POSTS_DIR}${path.sep}`)) {
		sendError(res, 400, "图片路径越界");
		return;
	}
	if (!(await exists(target))) {
		sendError(res, 404, "图片不存在");
		return;
	}
	const buffer = await readFile(target);
	const extension = path.extname(fileName).slice(1).toLowerCase();
	res.writeHead(200, {
		"content-type": MEDIA_TYPES.get(extension) || "application/octet-stream",
		"content-length": buffer.length,
		"cache-control": "no-store",
	});
	res.end(buffer);
}

async function route(req, res, url) {
	const pathname = safeDecode(url.pathname);
	const method = req.method || "GET";

	if (method === "GET" && STATIC_FILES.has(pathname)) {
		return sendStatic(res, STATIC_FILES.get(pathname));
	}
	if (method === "GET" && pathname.startsWith("/media/")) {
		return sendMedia(res, pathname.slice("/media/".length));
	}
	if (method === "GET" && pathname === "/api/state") {
		return sendJSON(res, 200, await getState());
	}
	if (method === "GET" && pathname === "/api/posts") {
		return sendJSON(res, 200, { ok: true, posts: await listPosts() });
	}
	if (method === "GET" && pathname === "/api/post") {
		const id = normalizeId(url.searchParams.get("id"));
		return sendJSON(res, 200, { ok: true, post: await loadPost(id) });
	}
	if (method === "GET" && pathname === "/api/post/images") {
		const id = normalizeId(url.searchParams.get("id"));
		if (!id) throw new Error("缺少文章 id");
		return sendJSON(res, 200, { ok: true, images: await listImages(id) });
	}
	if (method === "POST" && pathname === "/api/post/images") {
		const id = normalizeId(url.searchParams.get("id"));
		if (!id) throw new Error("先填标题和文件名再传图");
		resolvePostPath(id);
		const buffer = await readBody(req, MAX_UPLOAD_BYTES);
		const image = await saveImage(id, buffer, url.searchParams.get("name"));
		return sendJSON(res, 200, { ok: true, image });
	}
	if (method === "DELETE" && pathname === "/api/post/images") {
		const id = normalizeId(url.searchParams.get("id"));
		const file = url.searchParams.get("file");
		return sendJSON(res, 200, { ok: true, ...(await deleteImage(id, file)) });
	}
	if (method === "POST" && pathname === "/api/save") {
		const payload = await readJSON(req);
		const id = normalizeId(payload.id);
		if (!(await exists(resolvePostPath(id)))) assertNewPostId(id);
		return sendJSON(res, 200, { ok: true, saved: await savePost(payload) });
	}
	if (method === "POST" && pathname === "/api/publish") {
		const payload = await readJSON(req);
		const id = normalizeId(payload.id);
		if (!(await exists(resolvePostPath(id)))) assertNewPostId(id);
		return sendJSON(res, 200, await publishPost(payload));
	}
	if (method === "POST" && pathname === "/api/lqips") {
		const result = await runCommand("pnpm", ["lqips"]);
		return sendJSON(res, 200, {
			ok: result.code === 0,
			code: result.code,
			output: result.output.trim().split(/\r?\n/).slice(-8).join("\n"),
		});
	}

	sendJSON(res, 404, { ok: false, error: "没有这个接口" });
}

/* ----------------------------------------------------------------- 启动 */

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
		await route(req, res, url);
	} catch (error) {
		const message = describeError(error);
		if (res.headersSent) {
			res.end();
			return;
		}
		const status = /不合法|必须是|先填|缺少|不存在|超过|处理不了/.test(message)
			? 400
			: 500;
		sendError(res, status, message);
	}
});

server.on("error", (error) => {
	if (error && error.code === "EADDRINUSE") {
		console.error(
			`端口 ${PORT} 已被占用。可以换一个：BLOG_EDITOR_PORT=4399 pnpm blog`,
		);
	} else {
		console.error("编辑器启动失败：", error);
	}
	process.exit(1);
});

function openBrowser(target) {
	const platform = process.platform;
	const command =
		platform === "win32" ? ["cmd", ["/c", "start", "", target]] : platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]];
	try {
		const child = spawn(command[0], command[1], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.unref();
	} catch {
		/* 打不开就算了，手动点链接 */
	}
}

server.listen(PORT, HOST, () => {
	const address = `http://${HOST}:${PORT}`;
	console.log("");
	console.log(`  Firefly 博客编辑器已启动：${address}`);
	console.log(`  仓库：${ROOT}`);
	console.log("  写完点「发布」= 存盘 + commit + push，Ctrl+C 退出。");
	console.log("");
	if (process.env.BLOG_EDITOR_NO_OPEN !== "1") openBrowser(address);
});
