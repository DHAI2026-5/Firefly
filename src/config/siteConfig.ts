import type { SiteConfig } from "@/types/siteConfig";

// 定义站点语言
// 语言代码，例如：'zh_CN', 'zh_TW', 'en', 'ja', 'ru'。
const SITE_LANG = "zh_CN";

export const siteConfig: SiteConfig = {
	title: "和泉小站",
	subtitle: "在整了别催",
	site_url: "https://dhai2wwb.top/",
	description: "Firefly 是一款基于 Astro 框架和 Fuwari 模板开发的清新美观且现代化个人博客主题模板，专为技术爱好者和内容创作者设计。该主题融合了现代 Web 技术栈，提供了丰富的功能模块和高度可定制的界面，让您能够轻松打造出专业且美观的个人博客网站。",
	keywords: ["Fuwari", "Astro", "ACGN", "博客", "静态博客"],
	themeColor: {
		hue: 165,
		fixed: false,
		defaultMode: "system",
	},
	pageWidth: 100,
	card: {
		border: true,
		followTheme: false,
	},
	favicon: [
		{
			src: "/favicon/favicon.ico",
		},
	],
	navbar: {
		logo: {
			type: "image",
			value: "assets/images/firefly.png",
			alt: "🍀",
		},
		title: "Firefly",
		widthFull: false,
		menuAlign: "center",
		followTheme: false,
		stickyNavbar: true,
	},
	siteStartDate: "2025-01-01",
	timezone: "Asia/Shanghai",
	pages: {
		friends: true,
		sponsor: false,
		guestbook: true,
		bangumi: true,
		gallery: true,
		anime: true,
	},
	categoryBar: true,
	foldArticle: true,
	postListLayout: {
		defaultMode: "list",
		mobileDefaultMode: "list",
		showTags: true,
		descriptionLines: 2,
		allowSwitch: true,
		grid: {
			masonry: false,
			columnWidth: 320,
		},
	},
	post: {
		rehypeCallouts: {
			theme: "github",
			enablePythonMarkdownAdmonitions: false,
		},
		showLastModified: true,
		outdatedThreshold: 30,
		sharePoster: true,
		generateOgImages: false,
	},
	bangumi: {
		userId: "1143164",
		mode: "dynamic",
		apiUrl: "https://bgmapi.anibt.net",
		subjectBaseUrl: "https://bgmmi.anibt.net/subject/",
		categoryOrder: ["anime", "book", "music", "game"],
	},
	anime: {
		bilibili: {
			uid: "38932988",
		},
	},
	pagination: {
		postsPerPage: 10,
	},
	imageOptimization: {
		formats: "webp",
		quality: 85,
		noReferrerDomains: ["*.hdslb.com", "*.bilibili.com"],
	},
	lang: SITE_LANG,
};
