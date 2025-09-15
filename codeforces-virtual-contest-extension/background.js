// Background service worker (MV3) - manages contest state, timers, and polling Codeforces API

const STORAGE_KEYS = {
	state: 'contest_state',
	settings: 'user_settings',
	history: 'contest_history',
	banlist: 'banned_problems'
};

const DEFAULT_SETTINGS = {
	codeforcesHandle: '',
	pollIntervalSec: 60,
	adaptiveDifficulty: true,
	noDuplicateAcrossContests: true
};

const ALARM_NAMES = {
	poll: 'cf_poll_alarm',
	deadline: 'cf_deadline_alarm'
};

// Utility: promisified storage
function getStorage(keys) {
	return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
function setStorage(obj) {
	return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

// Utility: fetch JSON with retry
async function fetchJson(url, opts = {}, retries = 2) {
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(url, { ...opts, cache: 'no-store' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return await res.json();
		} catch (err) {
			if (attempt === retries) throw err;
			await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
		}
	}
}

function ratingInRange(rating, range) {
	if (rating == null) return false;
	const [min, max] = range;
	return rating >= min && (max === null ? true : rating <= max);
}

const DIFFICULTY_RANGES = {
	general: [800, null],
	easy: [800, 1200],
	medium: [1300, 1600],
	hard: [1700, 2000],
	veryhard: [2100, null]
};

function nowMs() { return Date.now(); }

function buildProblemUrl(problem) {
	return `https://codeforces.com/problemset/problem/${problem.contestId}/${problem.index}`;
}

function normalizeDifficultyKey(key) {
	if (!key) return 'general';
	const k = key.toLowerCase().replace(/\s+/g, '');
	if (['easy','medium','hard','veryhard','general'].includes(k)) return k;
	return 'general';
}

async function getUnsolvedProblemIds(handle) {
	if (!handle) return new Set();
	const url = `https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}&from=1&count=100000`;
	const data = await fetchJson(url);
	if (data.status !== 'OK') throw new Error('CF API error');
	const solvedSet = new Set();
	for (const sub of data.result) {
		if (sub.verdict === 'OK' && sub.problem && sub.problem.contestId && sub.problem.index) {
			solvedSet.add(`${sub.problem.contestId}-${sub.problem.index}`);
		}
	}
	return solvedSet;
}

async function fetchProblemset() {
	const url = 'https://codeforces.com/api/problemset.problems';
	const data = await fetchJson(url);
	if (data.status !== 'OK') throw new Error('CF API error');
	return data.result; // { problems:[], problemStatistics:[] }
}

function filterProblems({ allProblems, solvedSet, banSet, type, tags, difficultyKey }) {
	const diffKey = normalizeDifficultyKey(difficultyKey);
	const [min, max] = DIFFICULTY_RANGES[diffKey] || DIFFICULTY_RANGES.general;
	const selectedTags = (tags || []).map(t => t.toLowerCase());

	const pool = [];
	for (const p of allProblems) {
		if (!p.contestId || !p.index) continue;
		const pid = `${p.contestId}-${p.index}`;
		if (solvedSet.has(pid)) continue;
		if (banSet && banSet.has(pid)) continue;
		const rating = p.rating;
		if (!ratingInRange(rating ?? null, [min, max])) continue;
		if (type === 'topic') {
			if (!p.tags || !p.tags.length) continue;
			const ptags = p.tags.map(t => t.toLowerCase());
			if (!selectedTags.every(t => ptags.includes(t))) continue;
		} else if (type === 'mixed') {
			if (selectedTags.length > 0) {
				const ptags = (p.tags || []).map(t => t.toLowerCase());
				if (!ptags.some(t => selectedTags.includes(t))) continue;
			}
		}
		pool.push(p);
	}
	return pool;
}

function pickRandom(array, count) {
	const copy = array.slice();
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy.slice(0, count);
}

async function startContest(payload) {
	const { durationMinutes, numProblems, type, tags, difficulty, handle } = payload;
	const settingsRaw = await getStorage([STORAGE_KEYS.settings, STORAGE_KEYS.banlist]);
	const settings = { ...DEFAULT_SETTINGS, ...(settingsRaw[STORAGE_KEYS.settings] || {}) };
	const banlist = new Set(settingsRaw[STORAGE_KEYS.banlist] || []);
	const solvedSet = await getUnsolvedProblemIds(handle || settings.codeforcesHandle);
	const { problems } = await fetchProblemset();
	const pool = filterProblems({
		allProblems: problems,
		solvedSet,
		banSet: settings.noDuplicateAcrossContests ? banlist : new Set(),
		type,
		tags,
		difficultyKey: difficulty
	});
	const chosen = pickRandom(pool, numProblems).map(p => ({
		contestId: p.contestId,
		index: p.index,
		rating: p.rating ?? null,
		tags: p.tags || [],
		title: p.name,
		url: buildProblemUrl(p)
	}));

	const startMs = nowMs();
	const endMs = startMs + durationMinutes * 60 * 1000;
	const state = {
		status: 'running',
		startTime: startMs,
		endTime: endMs,
		config: { durationMinutes, numProblems, type, tags, difficulty, handle: handle || settings.codeforcesHandle },
		problems: chosen.map((p, idx) => ({ key: String.fromCharCode(65 + idx), ...p, submissions: [], verdict: null }))
	};

	await setStorage({ [STORAGE_KEYS.state]: state });

	// schedule alarms
	await chrome.alarms.clear(ALARM_NAMES.deadline);
	await chrome.alarms.create(ALARM_NAMES.deadline, { when: endMs });
	await chrome.alarms.clear(ALARM_NAMES.poll);
	await chrome.alarms.create(ALARM_NAMES.poll, { periodInMinutes: Math.max(0.5, settings.pollIntervalSec / 60) });

	chrome.runtime.sendMessage({ type: 'state_updated' });
	return state;
}

async function endContestIfNeeded() {
	const { [STORAGE_KEYS.state]: state } = await getStorage([STORAGE_KEYS.state]);
	if (!state || state.status !== 'running') return;
	if (nowMs() >= state.endTime) {
		state.status = 'ended';
		await setStorage({ [STORAGE_KEYS.state]: state });
		await addToHistory(state);
		chrome.runtime.sendMessage({ type: 'state_updated' });
	}
}

async function addToHistory(state) {
	const { [STORAGE_KEYS.history]: history } = await getStorage([STORAGE_KEYS.history]);
	const arr = Array.isArray(history) ? history : [];
	arr.unshift({ ...state, savedAt: nowMs() });
	await setStorage({ [STORAGE_KEYS.history]: arr });

	// Update banlist
	const { [STORAGE_KEYS.banlist]: ban } = await getStorage([STORAGE_KEYS.banlist]);
	const banSet = new Set(Array.isArray(ban) ? ban : []);
	for (const p of state.problems || []) banSet.add(`${p.contestId}-${p.index}`);
	await setStorage({ [STORAGE_KEYS.banlist]: Array.from(banSet) });
}

async function pollSubmissions() {
	const { [STORAGE_KEYS.state]: state } = await getStorage([STORAGE_KEYS.state]);
	if (!state || state.status !== 'running') return;
	const handle = state.config?.handle;
	if (!handle) return;
	const data = await fetchJson(`https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}&from=1&count=100000`);
	if (data.status !== 'OK') return;
	const byPid = new Map();
	for (const p of state.problems) byPid.set(`${p.contestId}-${p.index}`, p);
	let changed = false;
	for (const sub of data.result) {
		const pid = sub.problem && sub.problem.contestId && sub.problem.index ? `${sub.problem.contestId}-${sub.problem.index}` : null;
		if (!pid || !byPid.has(pid)) continue;
		const subTimeMs = (sub.creationTimeSeconds || 0) * 1000;
		if (subTimeMs < state.startTime || subTimeMs > state.endTime) continue;
		const p = byPid.get(pid);
		const exists = p.submissions.some(s => s.id === sub.id);
		if (!exists) {
			p.submissions.push({ id: sub.id, timeMs: subTimeMs, verdict: sub.verdict || 'UNKNOWN' });
			if (sub.verdict === 'OK') p.verdict = 'OK';
			changed = true;
		}
	}
	if (changed) {
		await setStorage({ [STORAGE_KEYS.state]: state });
		chrome.runtime.sendMessage({ type: 'state_updated' });
	}
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	(async () => {
		try {
			if (msg?.type === 'get_state') {
				const data = await getStorage([STORAGE_KEYS.state, STORAGE_KEYS.settings]);
				sendResponse({ ok: true, state: data[STORAGE_KEYS.state] || null, settings: { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] || {}) } });
			} else if (msg?.type === 'start_contest') {
				const state = await startContest(msg.payload);
				sendResponse({ ok: true, state });
			} else if (msg?.type === 'end_contest') {
				await endContestIfNeeded();
				sendResponse({ ok: true });
			} else if (msg?.type === 'save_settings') {
				const curr = await getStorage([STORAGE_KEYS.settings]);
				const merged = { ...DEFAULT_SETTINGS, ...(curr[STORAGE_KEYS.settings] || {}), ...(msg.payload || {}) };
				await setStorage({ [STORAGE_KEYS.settings]: merged });
				sendResponse({ ok: true, settings: merged });
			} else if (msg?.type === 'get_history') {
				const data = await getStorage([STORAGE_KEYS.history]);
				sendResponse({ ok: true, history: data[STORAGE_KEYS.history] || [] });
			} else if (msg?.type === 'clear_history') {
				await setStorage({ [STORAGE_KEYS.history]: [] });
				sendResponse({ ok: true });
			} else {
				sendResponse({ ok: false, error: 'Unknown message' });
			}
		} catch (e) {
			sendResponse({ ok: false, error: e?.message || String(e) });
		}
	})();
	return true; // keep channel open
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
	if (alarm.name === ALARM_NAMES.poll) {
		try { await pollSubmissions(); } catch (_) {}
	} else if (alarm.name === ALARM_NAMES.deadline) {
		try { await endContestIfNeeded(); } catch (_) {}
	}
});

// On install, seed defaults
chrome.runtime.onInstalled.addListener(async () => {
	const data = await getStorage([STORAGE_KEYS.settings]);
	if (!data[STORAGE_KEYS.settings]) {
		await setStorage({ [STORAGE_KEYS.settings]: DEFAULT_SETTINGS });
	}
});
