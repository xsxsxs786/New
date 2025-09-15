const $ = sel => document.querySelector(sel);

function msToHMS(ms) {
	if (ms < 0) ms = 0;
	const s = Math.floor(ms / 1000);
	const hh = Math.floor(s / 3600).toString().padStart(2, '0');
	const mm = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
	const ss = Math.floor(s % 60).toString().padStart(2, '0');
	return `${hh}:${mm}:${ss}`;
}

async function send(msg) {
	return new Promise(res => chrome.runtime.sendMessage(msg, res));
}

function parseTags(input) {
	return input.split(',').map(s => s.trim()).filter(Boolean);
}

function show(id) {
	document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
	$(id).classList.remove('hidden');
}

function renderProblems(state) {
	const list = $('#problems');
	list.innerHTML = '';
	for (const p of state.problems || []) {
		const li = document.createElement('li');
		const status = p.verdict === 'OK' ? '<span class="badge ok">AC</span>' : (p.submissions?.length ? '<span class="badge fail">Attempted</span>' : '<span class="badge pending">Pending</span>');
		li.innerHTML = `<strong>${p.key}.</strong> <a href="${p.url}" target="_blank" rel="noopener">${p.title}</a> ${status}`;
		list.appendChild(li);
	}
}

function renderContest(state) {
	const end = state.endTime;
	const now = Date.now();
	$('#countdown').textContent = msToHMS(end - now);
	const details = state.config || {};
	$('#contestDetails').innerHTML = `
		<div>Duration: ${Math.floor(details.durationMinutes/60)}h ${details.durationMinutes%60}m</div>
		<div>Type: ${details.type}</div>
		<div>Difficulty: ${details.difficulty}</div>
		<div>Handle: ${details.handle || ''}</div>
	`;
	renderProblems(state);
	$('#showResultsBtn').classList.toggle('hidden', state.status !== 'ended');
}

function renderResults(state) {
	const total = state.problems?.length || 0;
	const solved = state.problems?.filter(p => p.verdict === 'OK').length || 0;
	const attempts = state.problems?.reduce((acc, p) => acc + (p.submissions?.length || 0), 0) || 0;
	const successRate = total ? Math.round((solved / total) * 100) : 0;
	$('#resultsSummary').innerHTML = `
		<div>Total problems: ${total}</div>
		<div>Solved: ${solved}</div>
		<div>Total attempts: ${attempts}</div>
		<div>Success rate: ${successRate}%</div>
	`;
}

async function syncFromState() {
	const resp = await send({ type: 'get_state' });
	if (!resp.ok) return;
	const state = resp.state;
	const settings = resp.settings || {};
	if (!state || state.status === 'idle') {
		$('#handle').value = settings.codeforcesHandle || '';
		show('#view-start');
		return;
	}
	if (state.status === 'running') {
		show('#view-contest');
		renderContest(state);
	} else if (state.status === 'ended') {
		show('#view-contest');
		renderContest(state);
		$('#showResultsBtn').classList.remove('hidden');
	}
}

function tick() {
	syncFromState();
}

$('#startBtn').addEventListener('click', async () => {
	const handle = $('#handle').value.trim();
	const hours = Math.max(0, Math.min(3, parseInt($('#hours').value || '0', 10)));
	const minutes = Math.max(0, Math.min(59, parseInt($('#minutes').value || '0', 10)));
	const durationMinutes = hours * 60 + minutes;
	const numProblems = Math.max(1, Math.min(10, parseInt($('#numProblems').value || '4', 10)));
	const type = $('#contestType').value;
	const difficulty = $('#difficulty').value;
	const tags = parseTags($('#tags').value);

	$('#startBtn').disabled = true;
	const resp = await send({ type: 'start_contest', payload: { durationMinutes, numProblems, type, tags, difficulty, handle } });
	$('#startBtn').disabled = false;
	if (!resp.ok) {
		alert('Failed to start contest: ' + resp.error);
		return;
	}
	syncFromState();
});

$('#showResultsBtn').addEventListener('click', async () => {
	const resp = await send({ type: 'get_state' });
	if (!resp.ok) return;
	renderResults(resp.state);
	show('#view-results');
});

$('#backStartBtn').addEventListener('click', () => {
	show('#view-start');
});

chrome.runtime.onMessage.addListener((msg) => {
	if (msg?.type === 'state_updated') {
		syncFromState();
	}
});

setInterval(tick, 1000);
syncFromState();
