// dsh-searchops 浏览器侧边面板：会话头部按钮唤起，列出已配置的搜索源站，
// 逐源「检查连通性」（版本/集群/健康度）。数据走 loopback same-origin RPC
//（searchops/catalog、searchops/status，宿主侧 lib/rpc.js），凭证永远以
// configured/missing 布尔出现，面板不接触秘密值。宿主装有 better-sidebar
// 时改注册为原生侧栏 Tab；否则用自建 fixed 右侧面板（--dsh-searchops-width，
// 与 zterm 同款，避开与原生右栏/其他插件面板的宽度变量冲突）。
window.__ModuleLoader__.load({
	id: "dsh-searchops",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		// jsx-runtime 的签名是 jsx(type, props, key)：children 必须在 props 里，
		// 位置第三参是 key。这里包一层 createElement 风格的助手，调用侧保持
		// h(type, props, ...children) 的直觉写法（mindmap 的 children-in-props
		// 写法的语法糖等价）。
		const jsx = react_jsx_runtime.jsx;
		const jsxs = react_jsx_runtime.jsxs;
		const Fragment = react_jsx_runtime.Fragment;
		function h(type, props, ...kids) {
			if (kids.length === 0) return jsx(type, props ?? {});
			if (kids.length === 1) return jsx(type, { ...props, children: kids[0] });
			return jsxs(type, { ...props, children: kids });
		}
		const hs = h;
		const { useEffect, useRef, useState, useSyncExternalStore } = react;

		const TAB_ID = "dsh-searchops:panel";
		const WIDTH_KEY = "dsh-searchops.panel-width";
		const SETTINGS_NS = "searchops";
		// 与 Host 端 lib/constants.js 一致的派生前缀与上限（浏览器 bundle 不能 import
		// 服务端模块，故内联；输出必须与 Host 逐字一致，否则凭证 ref 对不上）。
		const USERNAME_REF_PREFIX = "SEARCHOPS_USERNAME_";
		const PASSWORD_REF_PREFIX = "SEARCHOPS_PASSWORD_";
		const TOKEN_REF_PREFIX = "SEARCHOPS_TOKEN_";
		const MAX_SOURCES = 50;
		const MAX_SOURCE_NAME_CHARS = 100;

		const STRINGS = {
			zh: {
				panelTitle: "SearchOps",
				panelDesc: "搜索源站一览与连通性检查（只读）。",
				open: "打开 SearchOps 面板",
				empty: "尚未配置搜索源站。到 设置 → 插件 → SearchOps 添加一个。",
				defaultBadge: "默认",
				credentialsConfigured: "凭证已配置",
				credentialsMissing: "凭证缺失",
				authNone: "无认证",
				authBasic: "Basic",
				authBearer: "Bearer",
				profileLabel: "字段档案",
				autoDetect: "自动识别",
				check: "检查连通性",
				checking: "检查中…",
				recheck: "重新检查",
				clusterLabel: "集群",
				versionLabel: "版本",
				healthLabel: "健康度",
				nodesLabel: "节点",
				reloadAll: "刷新列表",
				close: "关闭",
				loading: "读取配置中…",
				loadFailed: "读取配置失败",
				hostTooOld: "当前 DSH 宿主不支持面板通信（缺少 connection 服务）。请升级宿主后重试。",
				statusFailed: "检查失败",
				dragHandle: "调整面板宽度",
				// 设置页表单
				formHeading: "搜索源站",
				formIntro: "在此新增或编辑搜索源站。名称、URL、认证方式等保存在插件配置里；密码与令牌只写入 DSH 凭证库（只写不读，留空即保留当前值）。",
				addSource: "新增源站",
				sourceNameLabel: "名称",
				sourceNamePlaceholder: "例如：prod / 生产",
				nameRequired: "源站名称不能为空。",
				nameDuplicate: "源站名称必须唯一（不区分大小写）。",
				nameTooLong: "源站名称不能超过 100 个字符。",
				tooManySources: "源站数量不能超过 50 个。",
				urlRequired: "URL 不能为空。",
				invalidUrl: "URL 必须是不含凭证、查询参数或片段的绝对 HTTP(S) 地址。",
				authLabel: "认证方式",
				usernameLabel: "用户名（Basic，非秘密）",
				usernamePlaceholder: "例如：searchops-reader",
				secretLabelBasic: "密码（写入凭证库，不回显）",
				secretLabelBearer: "令牌（写入凭证库，不回显）",
				secretPlaceholder: "留空则保留当前值；输入新值以替换",
				secretHint: "存储 ref：{ref}",
				profileLabel: "字段档案名（可选）",
				profilePlaceholder: "留空 = 自动识别",
				insecureHttpLabel: "允许非回环主机走明文 HTTP",
				insecureHttpHint: "默认关闭：除 localhost 外要求 HTTPS，避免凭证明文传输。",
				setDefault: "设为默认",
				removeSource: "移除",
				confirmRemoveSource: "确定要移除该源站吗？关联凭证不会自动清除（可能被其他 profile 共用）。",
				saveAll: "保存全部",
				saving: "保存中…",
				savedSettings: "已保存。新调用即生效。",
				revisionConflict: "配置已在别处被修改。请点击「重新读取」确认最新内容后重试。",
				unconfirmedRead: "宿主返回的配置无法完全解析。为避免覆盖已存源站，保存已停用；请点击「重新读取」。",
				sharedCredentialHint: "凭证库可能被多个 profile 共用；替换或移除源站不会自动删除旧凭证。",
			},
			en: {
				panelTitle: "SearchOps",
				panelDesc: "Search sources and connectivity checks (read-only).",
				open: "Open the SearchOps panel",
				empty: "No search sources yet. Add one in Settings → Plugins → SearchOps.",
				defaultBadge: "Default",
				credentialsConfigured: "Credentials configured",
				credentialsMissing: "Credentials missing",
				authNone: "No auth",
				authBasic: "Basic",
				authBearer: "Bearer",
				profileLabel: "Field profile",
				autoDetect: "auto-detect",
				check: "Check connectivity",
				checking: "Checking…",
				recheck: "Recheck",
				clusterLabel: "Cluster",
				versionLabel: "Version",
				healthLabel: "Health",
				nodesLabel: "Nodes",
				reloadAll: "Reload list",
				close: "Close",
				loading: "Reading configuration…",
				loadFailed: "Failed to read configuration",
				hostTooOld: "This DSH host has no panel channel (the connection service is missing). Please upgrade the host.",
				statusFailed: "Check failed",
				dragHandle: "Resize panel",
				// Settings form
				formHeading: "Search sources",
				formIntro: "Add or edit search sources here. Name, URL and auth mode live in the plugin config; passwords and tokens go to the DSH credential store only (write-only; leave blank to keep the current value).",
				addSource: "Add source",
				sourceNameLabel: "Name",
				sourceNamePlaceholder: "e.g. prod / production",
				nameRequired: "Source name must not be empty.",
				nameDuplicate: "Source names must be unique (case-insensitive).",
				nameTooLong: "Source name must not exceed 100 characters.",
				tooManySources: "Too many sources (limit 50).",
				urlRequired: "URL must not be empty.",
				invalidUrl: "URL must be an absolute HTTP(S) address without credentials, query, or fragment.",
				authLabel: "Auth",
				usernameLabel: "Username (Basic, non-secret)",
				usernamePlaceholder: "e.g. searchops-reader",
				secretLabelBasic: "Password (credential store, never echoed)",
				secretLabelBearer: "Token (credential store, never echoed)",
				secretPlaceholder: "Leave blank to keep the current value; type to replace",
				secretHint: "Stored under ref: {ref}",
				profileLabel: "Field profile name (optional)",
				profilePlaceholder: "Empty = auto-detect",
				insecureHttpLabel: "Allow plain HTTP for non-loopback hosts",
				insecureHttpHint: "Off by default: HTTPS is required except for localhost, so credentials never travel in cleartext.",
				setDefault: "Set as default",
				removeSource: "Remove",
				confirmRemoveSource: "Remove this source? Its credentials are not cleared automatically (they may be shared across profiles).",
				saveAll: "Save all",
				saving: "Saving…",
				savedSettings: "Saved. New calls use the updated configuration.",
				revisionConflict: "The configuration changed elsewhere. Click “Reload” to review the latest content, then save again.",
				unconfirmedRead: "The host returned configuration data that cannot be fully parsed. Saving is disabled to avoid overwriting stored sources; click “Reload”.",
				sharedCredentialHint: "Profiles may share the credential store; replacing or removing a source does not delete old credentials.",
			},
		};

		function lang() {
			const nav = typeof navigator === "undefined" ? "" : String(navigator.language || "");
			return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
		}
		const t = (key) => STRINGS[lang()][key] ?? key;

		// ── 远端门面（grafana 同款）──────────────────────────────────────────
		// remote.settings / remote.credentials 由 dsh-api-remotes 以 remote.<ns>
		// 挂载。必须 ctx.get 延迟解析而不是写进 inject 名单：名单上任一缺席服务
		// 都会让 fiber 停在 INACTIVE，整个插件不加载。
		function remoteNamespace(ctx, ns) {
			return typeof ctx.get === "function" ? ctx.get(`remote.${ns}`) : undefined;
		}

		// 远端应答统一拆封：{ok:true,value} | {ok:false,error:{message}}；失败必须
		// 抛可读信息——静默降级成空数据会把故障伪装成「没有配置」。
		function unwrapRemote(response, what) {
			if (response && typeof response === "object" && response.ok === true) return response.value;
			const message = (response && typeof response === "object" ? response.error?.message : undefined) || `${what} failed`;
			throw new Error(message);
		}

		// ── 凭证 ref 派生（与 Host 端 lib/util.js 逐字一致）──────────────────
		function refSuffix(id) {
			return String(id ?? "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 64);
		}
		function usernameRefForId(id) { return `${USERNAME_REF_PREFIX}${refSuffix(id)}`; }
		function passwordRefForId(id) { return `${PASSWORD_REF_PREFIX}${refSuffix(id)}`; }
		function tokenRefForId(id) { return `${TOKEN_REF_PREFIX}${refSuffix(id)}`; }

		// 源站 id：系统生成、只读。crypto.randomUUID → getRandomValues 拼 v4 →
		// 时间+随机串兜底（与 grafana generateSourceId 同款）。
		function generateSourceId() {
			const c = globalThis.crypto;
			if (c && typeof c.randomUUID === "function") return String(c.randomUUID());
			if (c && typeof c.getRandomValues === "function") {
				const bytes = c.getRandomValues(new Uint8Array(16));
				bytes[6] = (bytes[6] & 0x0f) | 0x40;
				bytes[8] = (bytes[8] & 0x3f) | 0x80;
				const hex = Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
				return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
			}
			return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		}

		// Host 端 lib/config.js 的 stableIdFromName：手写配置可省 id，运行时按名
		// 字合成稳定 id（小写、非字母数字折叠为连字符、裁边、限长 48，空则
		// "default"）。客户端必须同款合成，否则无 id 的存量源站在表单里丢失、
		// 凭证 ref 也对不上。
		function stableIdFromName(name) {
			const slug = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
			return slug || "default";
		}

		// describe 读回的存储源站 → 表单草稿。id 缺省时按 Host 规则从名字合成，
		// 与运行时 effectiveSources 的派生一致。
		function normalizeStoredSource(raw) {
			if (!raw || typeof raw !== "object") return null;
			const name = typeof raw.name === "string" ? raw.name : "";
			const id = typeof raw.id === "string" && raw.id ? raw.id : (name ? stableIdFromName(name) : "");
			if (!id) return null;
			return {
				id,
				name,
				url: typeof raw.url === "string" ? raw.url : "",
				auth: ["none", "basic", "bearer"].includes(raw.auth) ? raw.auth : "basic",
				username: typeof raw.username === "string" ? raw.username : "",
				profile: typeof raw.profile === "string" ? raw.profile : "",
				usernameRef: typeof raw.usernameRef === "string" && raw.usernameRef ? raw.usernameRef : usernameRefForId(id),
				passwordRef: typeof raw.passwordRef === "string" && raw.passwordRef ? raw.passwordRef : passwordRefForId(id),
				tokenRef: typeof raw.tokenRef === "string" && raw.tokenRef ? raw.tokenRef : tokenRefForId(id),
			};
		}

		// 保存前统一校验（镜像 Host 端 validateConfig 的可前置部分）：
		// 名称必填、限长、唯一（大小写不敏感，与 Host 一致）；URL 必填且是
		// 不含凭证/查询/片段的绝对 HTTP(S) 地址；数量上限 50。
		function validateFormSources(drafts, m) {
			if (drafts.length > MAX_SOURCES) throw new Error(m.tooManySources);
			const seen = new Set();
			for (const d of drafts) {
				const name = String(d.name ?? "").trim();
				if (!name) throw new Error(m.nameRequired);
				if (name.length > MAX_SOURCE_NAME_CHARS) throw new Error(m.nameTooLong);
				const lower = name.toLowerCase();
				if (seen.has(lower)) throw new Error(m.nameDuplicate);
				seen.add(lower);
				const url = String(d.url ?? "").trim();
				if (!url) throw new Error(m.urlRequired);
				let parsed;
				try { parsed = new URL(url); } catch { throw new Error(m.invalidUrl); }
				if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
					throw new Error(m.invalidUrl);
				}
			}
		}

		// 草稿 → 写入 settings 的规范行（秘密值绝不进 config：只有 id/name/url/
		// auth/username/profile 七个非 secret 字段）。
		function configRowOf(draft) {
			return {
				id: draft.id,
				name: String(draft.name ?? "").trim(),
				url: String(draft.url ?? "").trim(),
				auth: draft.auth,
				username: draft.auth === "basic" ? String(draft.username ?? "").trim() : "",
				profile: String(draft.profile ?? "").trim(),
			};
		}

		// 凭证写入计划：有秘密草稿的行 → [{ref, value}]。basic 写密码、bearer
		// 写令牌，ref 优先用存储里显式配置的（共享凭证），否则按 id 派生。
		function buildCredentialWrites(drafts, storedById) {
			const writes = [];
			for (const d of drafts) {
				const value = String(d.secretDraft ?? "").trim();
				if (!value) continue;
				const stored = storedById.get(d.id) ?? null;
				const ref = d.auth === "bearer"
					? (stored?.tokenRef || tokenRefForId(d.id))
					: (d.auth === "basic" ? (stored?.passwordRef || passwordRefForId(d.id)) : null);
				if (ref) writes.push({ ref, value });
			}
			return writes;
		}

		function SearchopsIcon(size = 16) {
			return h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.3", "aria-hidden": "true" },
				h("circle", { cx: 7, cy: 7, r: 4.5 }),
				h("path", { d: "m10.5 10.5 3 3" }));
		}

		// 运行期解析 connection（不写进 inject 名单：名单上任一缺席服务都会让
		// fiber 停在 INACTIVE，整个插件不加载；缺失时面板降级提示即可）。
		function connectionOf(ctx) {
			return typeof ctx.get === "function" ? ctx.get("connection") : undefined;
		}

		async function rpc(ctx, method, payload, signal) {
			const connection = connectionOf(ctx);
			if (!connection?.rpc?.call) {
				const error = new Error("host unsupported");
				error.hostUnsupported = true;
				throw error;
			}
			const result = await connection.rpc.call("/api", `searchops/${method}`, payload ?? {}, signal);
			if (!result?.ok) throw new Error(result?.error?.message || `searchops/${method} failed`);
			return result.value;
		}

		const S = {
			panel: { position: "fixed", top: 0, right: 0, height: "100vh", display: "flex", flexDirection: "column", background: "var(--dsw-alias-bg-layer-1, #fff)", borderLeft: "1px solid var(--dsw-alias-border-l2, #ddd)", zIndex: 40, boxSizing: "border-box" },
			handle: { width: "5px", cursor: "col-resize", flexShrink: 0, touchAction: "none" },
			head: { display: "flex", alignItems: "center", gap: "8px", padding: "12px 14px", borderBottom: "1px solid var(--dsw-alias-border-l2, #ddd)", color: "var(--dsw-alias-label-primary, #222)" },
			headTitle: { margin: 0, fontSize: "14px", fontWeight: 600, flex: "1 1 auto" },
			spacer: { flex: "1 1 auto" },
			body: { flex: "1 1 auto", overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "10px" },
			sourceCard: { border: "1px solid var(--dsw-alias-border-l2, #ddd)", borderRadius: "10px", background: "var(--dsw-alias-bg-layer-2, #fafafa)", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" },
			sourceHead: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
			sourceName: { margin: 0, fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary, #222)" },
			badge: { fontSize: "11px", padding: "1px 7px", borderRadius: "999px", border: "1px solid var(--dsw-alias-border-l2, #ddd)", color: "var(--dsw-alias-label-secondary, #666)" },
			badgeOk: { fontSize: "11px", padding: "1px 7px", borderRadius: "999px", border: "1px solid #2da160", color: "#2da160" },
			badgeBad: { fontSize: "11px", padding: "1px 7px", borderRadius: "999px", border: "1px solid #d0453e", color: "#d0453e" },
			meta: { margin: 0, fontSize: "12px", color: "var(--dsw-alias-label-secondary, #666)", wordBreak: "break-all" },
			button: { alignSelf: "flex-start", font: "inherit", fontSize: "12px", padding: "4px 12px", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2, #ddd)", background: "var(--dsw-alias-bg-layer-3, #fff)", color: "var(--dsw-alias-label-primary, #222)", cursor: "pointer" },
			result: { margin: 0, fontSize: "12px", lineHeight: 1.6, color: "var(--dsw-alias-label-primary, #222)", whiteSpace: "pre-wrap", wordBreak: "break-word" },
			resultError: { margin: 0, fontSize: "12px", lineHeight: 1.6, color: "#d0453e", wordBreak: "break-word" },
			hint: { margin: 0, fontSize: "12px", color: "var(--dsw-alias-label-secondary, #666)" },
		};

		function SourceRow({ ctx, source }) {
			const [state, setState] = useState("idle");
			const [report, setReport] = useState(null);
			const abortRef = useRef(null);
			useEffect(() => () => abortRef.current?.abort(), []);
			const run = async () => {
				abortRef.current?.abort();
				const controller = new AbortController();
				abortRef.current = controller;
				setState("checking");
				setReport(null);
				try {
					const value = await rpc(ctx, "status", { source: source.name }, controller.signal);
					if (!controller.signal.aborted) {
						setReport({ ok: true, value });
						setState("done");
					}
				} catch (error) {
					if (controller.signal.aborted) return;
					setReport({ ok: false, message: error?.hostUnsupported ? t("hostTooOld") : String(error?.message || error) });
					setState("done");
				}
			};
			const authLabel = source.auth === "basic" ? t("authBasic") : source.auth === "bearer" ? t("authBearer") : t("authNone");
			return hs("div", { style: S.sourceCard },
				hs("div", { style: S.sourceHead },
					h("p", { style: S.sourceName }, source.name),
					source.isDefault ? h("span", { style: S.badge }, t("defaultBadge")) : null,
					h("span", { style: source.credentialsConfigured ? S.badgeOk : S.badgeBad },
						source.credentialsConfigured ? t("credentialsConfigured") : t("credentialsMissing"))),
				h("p", { style: S.meta }, `${source.url} · ${authLabel}`),
				h("p", { style: S.meta }, `${t("profileLabel")}: ${source.profile || t("autoDetect")}`),
				h("button", { style: S.button, onClick: run, disabled: state === "checking" },
					state === "checking" ? t("checking") : state === "done" ? t("recheck") : t("check")),
				report ? (report.ok
					? h("p", { style: S.result },
						`${t("clusterLabel")}: ${report.value.health?.clusterName ?? report.value.info?.clusterName ?? "?"}\n`
						+ `${t("versionLabel")}: ${report.value.info?.version ?? "?"} (${report.value.info?.distribution ?? "?"})\n`
						+ `${t("healthLabel")}: ${report.value.health?.status ?? "?"} · ${t("nodesLabel")}: ${report.value.health?.numberOfNodes ?? "?"}`)
					: h("p", { style: S.resultError }, `${t("statusFailed")}: ${report.message}`))
					: null);
		}

		function SearchopsPanel({ ctx }) {
			const [catalog, setCatalog] = useState(null);
			const [loadError, setLoadError] = useState("");
			const [reloadKey, setReloadKey] = useState(0);
			const abortRef = useRef(null);
			useEffect(() => {
				abortRef.current?.abort();
				const controller = new AbortController();
				abortRef.current = controller;
				setCatalog(null);
				setLoadError("");
				rpc(ctx, "catalog", {}, controller.signal)
					.then((value) => { if (!controller.signal.aborted) setCatalog(value); })
					.catch((error) => {
						if (controller.signal.aborted) return;
						setLoadError(error?.hostUnsupported ? t("hostTooOld") : String(error?.message || error));
					});
				return () => controller.abort();
			}, [ctx, reloadKey]);
			const sources = Array.isArray(catalog?.sources) ? catalog.sources : [];
			return hs("div", { style: { display: "flex", flexDirection: "column", gap: "10px", height: "100%" } },
				hs("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
					h("span", { style: S.spacer }),
					h("button", { style: S.button, onClick: () => setReloadKey((k) => k + 1) }, t("reloadAll"))),
				loadError ? h("p", { style: S.resultError }, `${t("loadFailed")}: ${loadError}`) : null,
				!loadError && !catalog ? h("p", { style: S.hint }, t("loading")) : null,
				catalog && sources.length === 0 ? h("p", { style: S.hint }, t("empty")) : null,
				sources.map((source) => h(SourceRow, { key: source.id || source.name, ctx, source })));
		}

		// ── 设置页可编辑表单（grafana 设置卡片范式）─────────────────────────
		const F = {
			wrap: { display: "flex", flexDirection: "column", gap: "12px", maxWidth: "720px" },
			intro: { margin: 0, fontSize: "13px", lineHeight: 1.6, color: "var(--dsw-alias-label-secondary, #666)" },
			toolbar: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			card: { border: "1px solid var(--dsw-alias-border-l2, #ddd)", borderRadius: "10px", background: "var(--dsw-alias-bg-layer-2, #fafafa)", padding: "14px", display: "flex", flexDirection: "column", gap: "10px" },
			cardHead: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			cardTitle: { margin: 0, fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary, #222)" },
			spacer: { flex: "1 1 auto" },
			badge: { fontSize: "11px", padding: "1px 7px", borderRadius: "999px", border: "1px solid var(--dsw-alias-border-l2, #ddd)", color: "var(--dsw-alias-label-secondary, #666)" },
			badgeOk: { fontSize: "11px", padding: "1px 7px", borderRadius: "999px", border: "1px solid #2da160", color: "#2da160" },
			badgeBad: { fontSize: "11px", padding: "1px 7px", borderRadius: "999px", border: "1px solid #d0453e", color: "#d0453e" },
			row: { display: "flex", flexDirection: "column", gap: "4px" },
			label: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #666)" },
			input: { font: "inherit", fontSize: "13px", padding: "6px 10px", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2, #ccc)", background: "var(--dsw-alias-bg-layer-1, #fff)", color: "var(--dsw-alias-label-primary, #222)", width: "100%", boxSizing: "border-box" },
			hint: { margin: 0, fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #999)" },
			button: { alignSelf: "flex-start", font: "inherit", fontSize: "12px", padding: "4px 12px", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2, #ddd)", background: "var(--dsw-alias-bg-layer-3, #fff)", color: "var(--dsw-alias-label-primary, #222)", cursor: "pointer" },
			buttonPrimary: { alignSelf: "flex-start", font: "inherit", fontSize: "12px", padding: "4px 14px", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2, #ddd)", background: "var(--dsw-alias-accent, #3b82f6)", color: "#fff", cursor: "pointer" },
			checkRow: { display: "flex", alignItems: "center", gap: "8px" },
			message: { margin: 0, fontSize: "12px", lineHeight: 1.6 },
			messageError: { margin: 0, fontSize: "12px", lineHeight: 1.6, color: "#d0453e", wordBreak: "break-word" },
			messageOk: { margin: 0, fontSize: "12px", lineHeight: 1.6, color: "#2da160" },
		};

		function isConflictError(message) {
			return /conflict|revision|changed since/i.test(String(message ?? ""));
		}

		function SettingsSourceCard({ draft, isDefault, credsInfo, onChange, onRemove, onSetDefault }) {
			const update = (patch) => onChange({ ...draft, ...patch });
			const secretLabel = draft.auth === "bearer" ? t("secretLabelBearer") : t("secretLabelBasic");
			const secretRef = draft.auth === "bearer"
				? (draft.tokenRef || tokenRefForId(draft.id))
				: passwordRefForId(draft.id);
			const configured = credsInfo && typeof credsInfo === "object" && credsInfo[secretRef]?.configured === true;
			return hs("div", { style: F.card },
				hs("div", { style: F.cardHead },
					h("p", { style: F.cardTitle }, draft.isNew ? t("addSource") : draft.name || t("sourceNamePlaceholder")),
					isDefault ? h("span", { style: F.badge }, t("defaultBadge")) : null,
					draft.auth !== "none"
						? h("span", { style: configured ? F.badgeOk : F.badgeBad }, configured ? t("credentialsConfigured") : t("credentialsMissing"))
						: null,
					h("span", { style: F.spacer }),
					isDefault ? null : h("button", { style: F.button, onClick: onSetDefault }, t("setDefault")),
					h("button", { style: F.button, onClick: onRemove }, t("removeSource"))),
				hs("div", { style: F.row },
					h("label", { style: F.label }, t("sourceNameLabel")),
					h("input", { style: F.input, value: draft.name, placeholder: t("sourceNamePlaceholder"), onChange: (e) => update({ name: e.target.value }) })),
				hs("div", { style: F.row },
					h("label", { style: F.label }, "URL"),
					h("input", { style: F.input, value: draft.url, placeholder: "https://search.example.com:9200", onChange: (e) => update({ url: e.target.value }) })),
				hs("div", { style: F.row },
					h("label", { style: F.label }, t("authLabel")),
					h("select", { style: { ...F.input, width: "auto" }, value: draft.auth, onChange: (e) => update({ auth: e.target.value }) },
						h("option", { value: "none" }, t("authNone")),
						h("option", { value: "basic" }, t("authBasic")),
						h("option", { value: "bearer" }, t("authBearer")))),
				draft.auth === "basic" ? hs("div", { style: F.row },
					h("label", { style: F.label }, t("usernameLabel")),
					h("input", { style: F.input, value: draft.username, placeholder: t("usernamePlaceholder"), autoComplete: "off", onChange: (e) => update({ username: e.target.value }) })) : null,
				draft.auth !== "none" ? hs("div", { style: F.row },
					h("label", { style: F.label }, secretLabel),
					h("input", { style: F.input, type: "password", value: draft.secretDraft, placeholder: t("secretPlaceholder"), autoComplete: "new-password", onChange: (e) => update({ secretDraft: e.target.value }) }),
					h("p", { style: F.hint }, t("secretHint").replace("{ref}", secretRef))) : null,
				hs("div", { style: F.row },
					h("label", { style: F.label }, t("profileLabel")),
					h("input", { style: F.input, value: draft.profile, placeholder: t("profilePlaceholder"), onChange: (e) => update({ profile: e.target.value }) })));
		}

		function SearchopsSettings({ ctx }) {
			const [status, setStatus] = useState("loading"); // loading | ready | error | unsupported
			const [error, setError] = useState("");
			const [drafts, setDrafts] = useState([]);
			const [storedById, setStoredById] = useState(() => new Map());
			const [defaultName, setDefaultName] = useState("");
			const [insecureHttp, setInsecureHttp] = useState(false);
			const [credsInfo, setCredsInfo] = useState({});
			const [revision, setRevision] = useState(null);
			const [unconfirmed, setUnconfirmed] = useState(false);
			const [saveMsg, setSaveMsg] = useState({ kind: "", text: "" });
			const [reloadKey, setReloadKey] = useState(0);

			const load = async () => {
				setStatus("loading");
				setError("");
				setSaveMsg({ kind: "", text: "" });
				const settings = remoteNamespace(ctx, "settings");
				if (!settings?.describe) { setStatus("unsupported"); return; }
				try {
					const described = unwrapRemote(await settings.describe(), "settings.describe");
					const ns = (Array.isArray(described?.namespaces) ? described.namespaces : []).find((n) => n?.ns === SETTINGS_NS);
					const value = ns && ns.value && typeof ns.value === "object" && !Array.isArray(ns.value) ? ns.value : {};
					const rawSources = Array.isArray(value.sources) ? value.sources : [];
					const normalized = rawSources.map(normalizeStoredSource).filter(Boolean);
					setUnconfirmed(!Array.isArray(described?.namespaces) || !ns || normalized.length !== rawSources.length);
					const map = new Map(normalized.map((s) => [s.id, s]));
					setStoredById(map);
					setDrafts(normalized.map((s) => ({ ...s, secretDraft: "", isNew: false })));
					const first = normalized[0]?.name ?? "";
					const storedDefault = typeof value.defaultSource === "string" ? value.defaultSource : "";
					setDefaultName(normalized.some((s) => s.name === storedDefault) ? storedDefault : first);
					setInsecureHttp(value.allowInsecureHttp === true);
					setRevision(Number.isInteger(ns?.revision) ? ns.revision : null);
					const credentials = remoteNamespace(ctx, "credentials");
					const refs = [...new Set(normalized.flatMap((s) => [s.passwordRef, s.tokenRef]))];
					let info = {};
					if (refs.length && credentials?.describe) {
						try {
							const result = unwrapRemote(await credentials.describe(refs), "credentials.describe");
							if (result && typeof result === "object" && !Array.isArray(result)) info = result;
						} catch { /* 状态失败≠缺失；不回显可能含敏感数据的错误 */ }
					}
					setCredsInfo(info);
					setStatus("ready");
				} catch (e) {
					setError(String(e?.message || e));
					setStatus("error");
				}
			};

			useEffect(() => { void load(); }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

			const save = async () => {
				if (status !== "ready" || unconfirmed) return;
				setSaveMsg({ kind: "info", text: t("saving") });
				try {
					validateFormSources(drafts, STRINGS[lang()]);
					const writes = buildCredentialWrites(drafts, storedById);
					if (writes.length) {
						const credentials = remoteNamespace(ctx, "credentials");
						if (!credentials?.set) throw new Error(t("hostTooOld"));
						for (const w of writes) unwrapRemote(await credentials.set(w.ref, w.value), "credentials.set");
					}
					const settings = remoteNamespace(ctx, "settings");
					if (!settings?.mutate) throw new Error(t("hostTooOld"));
					const effectiveDefault = drafts.some((d) => d.name.trim() === defaultName)
						? defaultName
						: (drafts[0] ? drafts[0].name.trim() : "");
					unwrapRemote(await settings.mutate(SETTINGS_NS, [
						{ op: "set", path: ["sources"], value: drafts.map(configRowOf) },
						{ op: "set", path: ["defaultSource"], value: effectiveDefault },
						{ op: "set", path: ["allowInsecureHttp"], value: insecureHttp },
					], Number.isInteger(revision) ? revision : void 0), "settings.mutate");
					await load();
					setSaveMsg({ kind: "ok", text: t("savedSettings") });
				} catch (e) {
					const message = String(e?.message || e);
					setSaveMsg({ kind: "error", text: isConflictError(message) ? t("revisionConflict") : message });
				}
			};

			const addSource = () => {
				setDrafts((list) => [...list, { id: generateSourceId(), name: "", url: "", auth: "none", username: "", profile: "", secretDraft: "", isNew: true }]);
				setSaveMsg({ kind: "", text: "" });
			};
			const removeSource = (id) => {
				if (!globalThis.confirm(t("confirmRemoveSource"))) return;
				setDrafts((list) => list.filter((d) => d.id !== id));
				setSaveMsg({ kind: "info", text: t("sharedCredentialHint") });
			};

			if (status === "unsupported") return h("p", { style: F.messageError }, t("hostTooOld"));
			return hs("div", { style: F.wrap },
				h("p", { style: F.intro }, t("formIntro")),
				hs("div", { style: F.toolbar },
					h("button", { style: F.button, onClick: () => setReloadKey((k) => k + 1) }, t("reloadAll")),
					h("button", { style: F.button, onClick: addSource }, t("addSource")),
					h("span", { style: F.spacer }),
					h("button", { style: F.buttonPrimary, onClick: save, disabled: status !== "ready" || unconfirmed || saveMsg.kind === "saving" }, saveMsg.kind === "saving" ? t("saving") : t("saveAll"))),
				status === "loading" ? h("p", { style: F.hint }, t("loading")) : null,
				status === "error" ? h("p", { style: F.messageError }, `${t("loadFailed")}: ${error}`) : null,
				unconfirmed && status === "ready" ? h("p", { style: F.messageError }, t("unconfirmedRead")) : null,
				drafts.map((draft) => h(SettingsSourceCard, {
					key: draft.id,
					draft,
					isDefault: draft.name.trim() === defaultName && draft.name.trim() !== "",
					credsInfo,
					onChange: (next) => setDrafts((list) => list.map((d) => (d.id === next.id ? next : d))),
					onRemove: () => removeSource(draft.id),
					onSetDefault: () => setDefaultName(draft.name.trim()),
				})),
				drafts.length === 0 && status === "ready" ? h("p", { style: F.hint }, t("empty")) : null,
				hs("label", { style: F.checkRow },
					h("input", { type: "checkbox", checked: insecureHttp, onChange: (e) => setInsecureHttp(e.target.checked) }),
					h("span", { style: F.label }, t("insecureHttpLabel"))),
				h("p", { style: F.hint }, t("insecureHttpHint")),
				saveMsg.kind === "ok" ? h("p", { style: F.messageOk }, saveMsg.text) : null,
				saveMsg.kind === "error" ? h("p", { style: F.messageError }, saveMsg.text) : null,
				saveMsg.kind === "info" ? h("p", { style: F.message }, saveMsg.text) : null);
		}

		// ── 面板承载形态 ──────────────────────────────────────────────────────
		// better-sidebar 可用时走原生侧栏 Tab；否则渲染 fixed 右侧面板并同步
		// --dsh-searchops-width + #root 右边距（与 zterm 的 standalone 方案同款）。
		function Standalone({ ctx, onClose }) {
			const bounds = (value) => Math.min(window.innerWidth * 0.8, Math.max(280, value));
			const [width, setWidth] = useState(() => {
				const saved = Number.parseFloat(globalThis.localStorage?.getItem(WIDTH_KEY) ?? "");
				return bounds(Number.isFinite(saved) && saved > 0 ? saved : Math.min(420, window.innerWidth * 0.45));
			});
			const startRef = useRef(null);
			const onHandleDown = (event) => {
				event.preventDefault();
				const startX = event.clientX;
				const initial = width;
				const move = (e) => setWidth(bounds(initial + startX - e.clientX));
				const up = () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
					startRef.current = null;
				};
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
			};
			useEffect(() => {
				globalThis.localStorage?.setItem(WIDTH_KEY, String(width));
				document.documentElement.style.setProperty("--dsh-searchops-width", `${width}px`);
				const style = document.createElement("style");
				style.dataset.plugin = "dsh-searchops";
				style.textContent = "#root{margin-right:calc(var(--dsh-searchops-width,0px) + var(--dsh-sidebar-width,0px))!important;width:calc(100% - var(--dsh-searchops-width,0px) - var(--dsh-sidebar-width,0px))!important}";
				document.head.appendChild(style);
				return () => {
					style.remove();
					document.documentElement.style.removeProperty("--dsh-searchops-width");
				};
			}, [width]);
			return hs("section", { style: { ...S.panel, width }, "aria-label": t("panelTitle") },
				h("div", { style: S.handle, role: "separator", "aria-label": t("dragHandle"), onMouseDown: onHandleDown }),
				hs("div", { style: { display: "flex", flexDirection: "column", flex: "1 1 auto", minWidth: 0 } },
					hs("div", { style: S.head },
						SearchopsIcon(15),
						h("p", { style: S.headTitle }, t("panelTitle")),
						h("button", { style: S.button, onClick: onClose }, t("close"))),
					h("div", { style: S.body }, h(SearchopsPanel, { ctx }))));
		}

		// better-sidebar 服务总线（zterm 同款）：有则注册原生 Tab，无则按钮走自建面板。
		const sidebarListeners = new Set();
		let sidebarService;
		const notifySidebar = () => sidebarListeners.forEach((listener) => listener());
		const useSidebar = () => useSyncExternalStore(
			(listener) => { sidebarListeners.add(listener); return () => sidebarListeners.delete(listener); },
			() => sidebarService);

		function HeaderButton({ ctx }) {
			const sidebar = useSidebar();
			const [standalone, setStandalone] = useState(false);
			const open = () => {
				if (sidebar?.openTab) {
					sidebar.openTab({ type: TAB_ID, title: t("panelTitle"), url: "searchops://panel" }, {});
				} else {
					setStandalone(true);
				}
			};
			return h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px" } },
				h("button", { title: t("open"), "aria-label": t("open"), onClick: open,
					style: { display: "inline-flex", alignItems: "center", gap: "6px", font: "inherit", fontSize: "12px",
						padding: "4px 10px", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2, #ddd)",
						background: "transparent", color: "var(--dsw-alias-label-secondary, #666)", cursor: "pointer" } },
					SearchopsIcon(14), t("panelTitle")),
				standalone ? h(Standalone, { ctx, onClose: () => setStandalone(false) }) : null);
		}

		const inject = ["slots"];

		function apply(ctx) {
			// 与 zterm 一致：optional inject，宿主没有 better-sidebar 只是少一个入口形态。
			ctx.inject(["betterSidebar"], (sctx) => {
				const disposeTab = typeof sctx.betterSidebar?.registerTab === "function"
					? sctx.betterSidebar.registerTab({
						id: TAB_ID,
						title: () => t("panelTitle"),
						description: t("panelDesc"),
						icon: SearchopsIcon,
						single: true,
						order: 108,
						component: () => h(SearchopsPanel, { ctx }),
					})
					: undefined;
				const disposeTitle = sctx.slots?.inject
					? sctx.slots.inject("sidebar.right.pane.tab.title", () => sctx.slots.register({
						name: "sidebar.right.pane.tab.title",
						key: `dsh-better-sidebar:${TAB_ID}`,
						priority: -1,
					}, () => h("span", { style: { display: "inline-flex", alignItems: "center", gap: "4px" } },
						h("span", { "aria-hidden": "true" }, SearchopsIcon()), t("panelTitle"))))
					: undefined;
				sidebarService = sctx.betterSidebar;
				notifySidebar();
				return () => {
					disposeTitle?.();
					disposeTab?.();
					sidebarService = undefined;
					notifySidebar();
				};
			});
			// 顶栏快捷入口暂时隐藏（用户要求）；恢复时取消注释即可。
			// ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
			// 	name: "conversation.session.header.actions",
			// 	id: "dsh-searchops",
			// 	order: 108,
			// }, (props) => h(HeaderButton, { ctx, ...props })));
			// 设置页左栏入口（settings.section，root scope）：可编辑表单——新增/编辑
			// 源站、写凭证（credentials.set 只写不读）、设默认、开关明文 HTTP。
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-searchops",
				order: 108,
				label: "SearchOps",
				icon: SearchopsIcon,
			}, () => h("div", { style: { padding: "4px 8px" } }, h(SearchopsSettings, { ctx }))));
		}

		exports.apply = apply;
		exports.inject = inject;
		// STRINGS 入 internals 是为拦住双语文案键缺失（仓库无 DOM 测试台）；其余为
		// 设置表单的纯函数面（ref 派生 / 校验 / 写入计划），供测试驱动。
		exports.internals = Object.freeze({
			STRINGS,
			TAB_ID,
			WIDTH_KEY,
			refSuffix,
			usernameRefForId,
			passwordRefForId,
			tokenRefForId,
			generateSourceId,
			stableIdFromName,
			normalizeStoredSource,
			validateFormSources,
			configRowOf,
			buildCredentialWrites,
			isConflictError,
		});
		return module.exports;
	}
});
