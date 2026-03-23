// ==UserScript==
// @name         WOS Download Bot Enhanced
// @namespace    https://github.com/chugit/wos-download-bot-enhanced/
// @version      2.0.0
// @description  Web of Science 核心合集批量导出助手（优化重构版：暂停/继续/停止/断点续传/预热/中断当前请求）
// @author       chugit
// @supportURL   https://github.com/chugit/wos-download-bot-enhanced/
// @downloadURL  https://raw.githubusercontent.com/chugit/wos-download-bot-enhanced/main/wos-download-bot-enhanced.js
// @updateURL    https://raw.githubusercontent.com/chugit/wos-download-bot-enhanced/main/wos-download-bot-enhanced.js
// @match        https://*.webofscience.com/wos/woscc/summary/*/relevance/*
// @match        https://*.webofscience.com/wos/woscc/summary/*/recently-added/*
// @match        https://*.webofscience.com/wos/woscc/summary/*/times-cited-descending/*
// @match        https://*.webofscience.com/wos/woscc/summary/*/times-cited-ascending/*
// @match        https://*.webofscience.com/wos/woscc/summary/*/date-descending/*
// @match        https://*.webofscience.com/wos/woscc/summary/*/date-ascending/*
// @match        https://*.clarivate.cn/wos/woscc/summary/*/relevance/*
// @match        https://*.clarivate.cn/wos/woscc/summary/*/recently-added/*
// @match        https://*.clarivate.cn/wos/woscc/summary/*/times-cited-descending/*
// @match        https://*.clarivate.cn/wos/woscc/summary/*/times-cited-ascending/*
// @match        https://*.clarivate.cn/wos/woscc/summary/*/date-descending/*
// @match        https://*.clarivate.cn/wos/woscc/summary/*/date-ascending/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=webofscience.com
// @grant        none
// @license      MIT
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    const CONFIG = Object.freeze({
        VERSION: '2.0.0',
        PAGE_SIZE: 500,
        RECOMMENDED_DIRECT_START_MAX: 99501,
        MAX_HARD_STOP: 200000,
        MAX_ALLOWED_START: 199501,

        WARMUP_DELAY_MIN: 3,
        WARMUP_DELAY_MAX: 8,

        NORMAL_DELAY_MIN_ALLOWED: 10,
        NORMAL_DELAY_DEFAULT: 20,

        MAX_RETRIES: 2,
        RETRY_BASE_MS: 2500,
        REQUEST_TIMEOUT_MS: 120000,

        MAIN_BUTTON_ID: 'wos-download-bot-btn',
        POPUP_ID: 'wos-download-bot-popup',
        CONTROL_PANEL_ID: 'wos-download-bot-control-panel',
        STYLE_ID: 'wos-download-bot-style',
        STORAGE_PREFIX: 'wos_download_bot_task_v3_',

        SUPPORTED_SORTS: [
            'relevance',
            'recently-added',
            'times-cited-descending',
            'times-cited-ascending',
            'date-descending',
            'date-ascending'
        ]
    });

    const TASK_STATUS = Object.freeze({
        IDLE: 'idle',
        RUNNING: 'running',
        PAUSED: 'paused',
        STOPPED: 'stopped',
        COMPLETED: 'completed',
        ERROR: 'error'
    });

    const SORTS_PATTERN = CONFIG.SUPPORTED_SORTS.join('|');
    const PAGE_REGEX = new RegExp(
        `^https:\\/\\/[^/]+\\.(?:webofscience\\.com|clarivate\\.cn)\\/wos\\/woscc\\/summary\\/[^/]+\\/(?:${SORTS_PATTERN})\\/`,
        'i'
    );
    const QID_REGEX = new RegExp(`/wos/woscc/summary/([^/]+)/(${SORTS_PATTERN})/`, 'i');
    const SORT_REGEX = new RegExp(`/wos/woscc/summary/[^/]+/(${SORTS_PATTERN})/`, 'i');

    const runtime = {
        currentTask: null,
        timerId: null,
        pauseRequested: false,
        stopRequested: false,
        currentFetchController: null,
        observer: null,
        urlCheckTimer: null,
        autoResumeAsked: false
    };

    const dom = {
        byId(id) {
            return document.getElementById(id);
        },
        remove(id) {
            const el = typeof id === 'string' ? document.getElementById(id) : id;
            if (el) el.remove();
        },
        create(tag, attrs = {}, html = '') {
            const el = document.createElement(tag);
            for (const [k, v] of Object.entries(attrs)) {
                if (k === 'style' && typeof v === 'object') {
                    Object.assign(el.style, v);
                } else if (k.startsWith('on') && typeof v === 'function') {
                    el.addEventListener(k.slice(2), v);
                } else if (k === 'className') {
                    el.className = v;
                } else {
                    el.setAttribute(k, v);
                }
            }
            if (html) el.innerHTML = html;
            return el;
        }
    };

    function log(...args) {
        console.log('[WOS-DB]', ...args);
    }

    function nowISO() {
        return new Date().toISOString();
    }

    function getCurrentUrl() {
        return String(location.href);
    }

    function isSupportedPage(url = getCurrentUrl()) {
        return PAGE_REGEX.test(url);
    }

    function getParentQid(url = getCurrentUrl()) {
        const match = url.match(QID_REGEX);
        return match ? match[1] : '';
    }

    function getSortBy(url = getCurrentUrl()) {
        const match = url.match(SORT_REGEX);
        return match ? match[1] : 'relevance';
    }

    function getSessionID() {
        try {
            return window.sessionData?.BasicProperties?.SID || '';
        } catch (err) {
            log('读取 sessionData.BasicProperties.SID 失败：', err);
            return '';
        }
    }

    function getTaskKey() {
        return `${location.origin}__${getParentQid()}__${getSortBy()}`;
    }

    function getStorageKey(taskKey = getTaskKey()) {
        return CONFIG.STORAGE_PREFIX + taskKey;
    }

    function safeJsonParse(text, fallback = null) {
        try {
            return JSON.parse(text);
        } catch {
            return fallback;
        }
    }

    function loadTask(taskKey = getTaskKey()) {
        const raw = localStorage.getItem(getStorageKey(taskKey));
        return raw ? safeJsonParse(raw, null) : null;
    }

    function saveTask(task) {
        if (!task?.taskKey) return;
        localStorage.setItem(getStorageKey(task.taskKey), JSON.stringify(task));
    }

    function removeTask(taskKey = getTaskKey()) {
        localStorage.removeItem(getStorageKey(taskKey));
    }

    function setRuntimeTask(task) {
        runtime.currentTask = task || null;
    }

    function clearRuntimeTask() {
        runtime.currentTask = null;
    }

    function clearRuntimeControls() {
        runtime.pauseRequested = false;
        runtime.stopRequested = false;

        if (runtime.timerId) {
            clearTimeout(runtime.timerId);
            runtime.timerId = null;
        }

        if (runtime.currentFetchController) {
            runtime.currentFetchController.abort();
            runtime.currentFetchController = null;
        }
    }

    function sleep(ms) {
        return new Promise(resolve => {
            if (runtime.timerId) clearTimeout(runtime.timerId);
            runtime.timerId = setTimeout(() => {
                runtime.timerId = null;
                resolve();
            }, ms);
        });
    }

    function randomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function sanitizeFilenamePart(value, fallback = 'unknown') {
        const text = String(value ?? '').trim();
        if (!text) return fallback;

        const result = text
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '');

        return result || fallback;
    }

    function getFileOptByFormat(format) {
        if (format === 'excel') return 'xls';
        return 'othersoftware';
    }

    function getActionByFormat(format) {
        switch (format) {
            case 'excel': return 'saveToExcel';
            case 'ris': return 'saveToRIS';
            case 'bibtex': return 'saveToBibtex';
            case 'txt':
            default:
                return 'saveToFieldTagged';
        }
    }

    function getFiltersByFormat(format) {
        if (format === 'excel' || format === 'ris') return 'fullRecord';
        return 'fullRecordPlus';
    }

    function getDownloadFileExtByFormat(format) {
        switch (format) {
            case 'excel': return '.xls';
            case 'ris': return '.ris';
            case 'bibtex': return '.bib';
            case 'txt':
            default:
                return '.txt';
        }
    }

    function buildDownloadFileName(task, start, stop) {
        const sortPart = sanitizeFilenamePart(task?.sortBy || 'unknown-sort');
        const qidPart = sanitizeFilenamePart(task?.parentQid || 'unknown-qid');
        const ext = getDownloadFileExtByFormat(task?.fileFormat || 'txt');
        return `wos_${sortPart}_${qidPart}_${start}-${stop}${ext}`;
    }

    function downloadBlob(fileName, blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
    }

    function formatError(err, fallback = '下载出错') {
        if (!err) return fallback;

        if (err.name === 'AbortError') {
            return `${fallback}：请求已中断`;
        }

        if (typeof err === 'string') {
            return `${fallback}：${err}`;
        }

        const status = err.status || err.code || '';
        const message =
            err.message ||
            err.statusText ||
            err.responseText ||
            err.response ||
            '';

        return status || message
            ? `${fallback}：${[status, message].filter(Boolean).join(' ')}`
            : fallback;
    }

    function shouldRetry(err) {
        if (!err) return false;
        if (err.name === 'AbortError') return false;

        const status = Number(err.status || 0);
        if (status === 0) return true;
        if (status >= 500) return true;

        const msg = String(err.message || err.statusText || '').toLowerCase();
        return msg.includes('timeout') || msg.includes('network') || msg.includes('fetch');
    }

    function getSafeStop(start, totalCount, desiredStop) {
        return Math.min(desiredStop, totalCount, CONFIG.MAX_HARD_STOP);
    }

    function createTask({ start, totalCount, fileFormat, waitSecond }) {
        const requestedStart = parseInt(start, 10);
        const total = parseInt(totalCount, 10);
        const warmupMode = requestedStart > CONFIG.RECOMMENDED_DIRECT_START_MAX;
        const initialStart = warmupMode ? CONFIG.RECOMMENDED_DIRECT_START_MAX : requestedStart;
        const initialStop = getSafeStop(initialStart, total, initialStart + CONFIG.PAGE_SIZE - 1);

        return {
            taskKey: getTaskKey(),
            origin: location.origin,
            url: getCurrentUrl(),
            parentQid: getParentQid(),
            sortBy: getSortBy(),
            total,
            fileFormat,
            waitSecond,

            requestedStart,
            warmupMode,

            nextStart: initialStart,
            nextStop: initialStop,

            lastSuccessStart: null,
            lastSuccessStop: null,
            completedRanges: [],

            status: TASK_STATUS.IDLE,
            createdAt: nowISO(),
            updatedAt: nowISO(),
            finishedAt: null,
            lastError: null
        };
    }

    function getStatusText(task) {
        if (!task) return '无任务';
        if (task.status === TASK_STATUS.RUNNING && task.warmupMode) return '预热中';

        switch (task.status) {
            case TASK_STATUS.RUNNING: return '下载中';
            case TASK_STATUS.PAUSED: return '已暂停';
            case TASK_STATUS.STOPPED: return '已停止';
            case TASK_STATUS.COMPLETED: return '已完成';
            case TASK_STATUS.ERROR: return '出错';
            default: return '空闲';
        }
    }

    function getProgressValue(task) {
        return task?.lastSuccessStop || 0;
    }

    function getProgressText(task) {
        if (!task) return '0 / 0';
        return `${getProgressValue(task)} / ${task.total}`;
    }

    function getPercent(task) {
        if (!task?.total) return 0;
        return Math.min(100, Math.floor((getProgressValue(task) / task.total) * 100));
    }

    function upsertTask(task, { persist = true, syncRuntime = true, refreshUI = true } = {}) {
        task.updatedAt = nowISO();
        if (persist) saveTask(task);
        if (syncRuntime) setRuntimeTask(task);
        if (refreshUI) {
            updateMainButton();
            updateControlPanel();
        }
    }

    function markTaskStatus(task, status, errorText = null) {
        task.status = status;
        if (errorText !== null) task.lastError = String(errorText);
        if (status === TASK_STATUS.COMPLETED || status === TASK_STATUS.STOPPED) {
            task.finishedAt = nowISO();
        }
        upsertTask(task);
    }

    function ensureStyle() {
        if (dom.byId(CONFIG.STYLE_ID)) return;

        const style = dom.create('style', { id: CONFIG.STYLE_ID });
        style.textContent = `
            #${CONFIG.MAIN_BUTTON_ID} {
                width: 120px;
                position: fixed;
                top: 120px;
                right: 50px;
                background: #5e33bf;
                color: #fff;
                font-size: 16px;
                z-index: 999998;
                border-radius: 6px;
                text-align: center;
                border: none;
                padding: 10px 12px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                cursor: pointer;
            }
            #${CONFIG.MAIN_BUTTON_ID}[disabled] {
                opacity: .75;
                cursor: not-allowed;
            }
            .wdb-card {
                position: fixed;
                right: 50px;
                background: #fff;
                color: #222;
                border: 1px solid #ddd;
                border-radius: 10px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.18);
                z-index: 999997;
                font-size: 13px;
            }
            .wdb-popup {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: #fff;
                padding: 20px;
                border: 1px solid #ccc;
                border-radius: 10px;
                z-index: 999999;
                box-shadow: 0 8px 30px rgba(0,0,0,0.2);
                min-width: 420px;
                color: #222;
                font-family: Arial, sans-serif;
            }
            .wdb-actions {
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
                margin-top: 12px;
            }
            .wdb-actions button {
                padding: 6px 12px;
                cursor: pointer;
            }
            .wdb-muted {
                margin-top: 8px;
                color: #666;
                font-size: 12px;
                line-height: 1.6;
            }
            .wdb-field {
                margin-bottom: 10px;
            }
            .wdb-field input, .wdb-field select {
                margin-left: 8px;
                width: 140px;
            }
        `;
        document.head.appendChild(style);
    }

    function enableMainButton(text = '一键下载') {
        const btn = dom.byId(CONFIG.MAIN_BUTTON_ID);
        if (!btn) return;
        btn.textContent = text;
        btn.disabled = false;
    }

    function disableMainButton(text = '正在下载...') {
        const btn = dom.byId(CONFIG.MAIN_BUTTON_ID);
        if (!btn) return;
        btn.textContent = text;
        btn.disabled = true;
    }

    function updateMainButton() {
        const task = runtime.currentTask || loadTask();

        if (!task) {
            enableMainButton('一键下载');
            return;
        }

        if (task.status === TASK_STATUS.RUNNING) {
            disableMainButton(`${task.warmupMode ? '预热中' : '下载中'} ${task.nextStart}-${task.nextStop}`);
            return;
        }

        if (task.status === TASK_STATUS.PAUSED) {
            enableMainButton('继续下载');
            return;
        }

        if (task.status === TASK_STATUS.ERROR) {
            enableMainButton('恢复下载');
            return;
        }

        if (task.status === TASK_STATUS.COMPLETED) {
            enableMainButton('已完成');
            setTimeout(() => enableMainButton('一键下载'), 1500);
            return;
        }

        enableMainButton('一键下载');
    }

    function removePopup() {
        dom.remove(CONFIG.POPUP_ID);
    }

    function removeControlPanel() {
        dom.remove(CONFIG.CONTROL_PANEL_ID);
    }

    function createControlPanel(task) {
        removeControlPanel();

        const panel = dom.create('div', {
            id: CONFIG.CONTROL_PANEL_ID,
            className: 'wdb-card',
            style: {
                top: '180px',
                width: '330px',
                overflow: 'hidden'
            }
        });

        panel.innerHTML = `
            <div style="background:#5e33bf;color:#fff;padding:10px 12px;font-weight:bold;">
                下载任务控制台
            </div>
            <div style="padding:12px;line-height:1.7;">
                <div><b>状态：</b><span id="wos-task-status"></span></div>
                <div><b>进度：</b><span id="wos-task-progress"></span>（<span id="wos-task-percent"></span>）</div>
                <div><b>格式：</b><span id="wos-task-format"></span></div>
                <div><b>排序：</b><span id="wos-task-sort"></span></div>
                <div><b>下批范围：</b><span id="wos-task-next-range"></span></div>
                <div><b>上次完成：</b><span id="wos-task-last-range"></span></div>
                <div style="word-break:break-all;"><b>错误：</b><span id="wos-task-error"></span></div>
                <div class="wdb-actions">
                    <button id="wos-btn-pause">暂停</button>
                    <button id="wos-btn-resume">继续</button>
                    <button id="wos-btn-stop">停止</button>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        dom.byId('wos-btn-pause')?.addEventListener('click', requestPause);
        dom.byId('wos-btn-resume')?.addEventListener('click', resumeTask);
        dom.byId('wos-btn-stop')?.addEventListener('click', requestStop);

        updateControlPanel(task);
    }

    function updateControlPanel(task = runtime.currentTask || loadTask()) {
        if (!task) {
            removeControlPanel();
            return;
        }

        const panel = dom.byId(CONFIG.CONTROL_PANEL_ID);
        if (!panel) {
            createControlPanel(task);
            return;
        }

        const setText = (id, value) => {
            const el = dom.byId(id);
            if (el) el.textContent = String(value);
        };

        setText('wos-task-status', getStatusText(task));
        setText('wos-task-progress', getProgressText(task));
        setText('wos-task-percent', `${getPercent(task)}%`);
        setText('wos-task-format', task.fileFormat);
        setText('wos-task-sort', task.sortBy);
        setText('wos-task-next-range', `${task.nextStart || '-'} - ${task.nextStop || '-'}`);
        setText(
            'wos-task-last-range',
            task.lastSuccessStart && task.lastSuccessStop
                ? `${task.lastSuccessStart} - ${task.lastSuccessStop}`
                : '-'
        );
        setText('wos-task-error', task.lastError || '-');

        const isRunning = task.status === TASK_STATUS.RUNNING;
        const canResume = task.status === TASK_STATUS.PAUSED || task.status === TASK_STATUS.ERROR;
        const isDone = task.status === TASK_STATUS.COMPLETED;

        const pauseBtn = dom.byId('wos-btn-pause');
        const resumeBtn = dom.byId('wos-btn-resume');
        const stopBtn = dom.byId('wos-btn-stop');

        if (pauseBtn) pauseBtn.disabled = !isRunning || isDone;
        if (resumeBtn) resumeBtn.disabled = !canResume || isDone;
        if (stopBtn) stopBtn.disabled = !(isRunning || canResume) || isDone;
    }

    function requestPause() {
        const task = runtime.currentTask || loadTask();
        if (!task || task.status !== TASK_STATUS.RUNNING) return;
        runtime.pauseRequested = true;
        log('已请求暂停：当前批次完成后暂停');
    }

    function finalizeStop(task, shouldAlert = true) {
        if (!task) return;

        task.status = TASK_STATUS.STOPPED;
        task.finishedAt = nowISO();

        removeTask(task.taskKey);
        clearRuntimeTask();
        removeControlPanel();
        clearRuntimeControls();
        enableMainButton('一键下载');

        if (shouldAlert) {
            alert('下载已停止，任务记录已清除');
        }
    }

    function requestStop() {
        const task = runtime.currentTask || loadTask();
        if (!task) return;

        const ok = confirm('停止后将清空当前任务进度记录，确定停止吗？');
        if (!ok) return;

        runtime.stopRequested = true;
        runtime.pauseRequested = false;

        if (runtime.currentFetchController) {
            runtime.currentFetchController.abort();
        }

        if (task.status !== TASK_STATUS.RUNNING) {
            finalizeStop(task, false);
        }
    }

    function getTotal() {
        const selectors = [
            '[data-ta="search-history-count"]',
            '.mat-mdc-paginator-range-label',
            '.brand-blue',
            '.end-page.ng-star-inserted'
        ];

        for (const selector of selectors) {
            const el = document.querySelector(selector);
            const text = el?.textContent?.trim();
            if (!text) continue;

            const nums = text.match(/\d[\d,]*/g);
            if (!nums?.length) continue;

            const value = parseInt(nums[nums.length - 1].replace(/,/g, ''), 10);
            if (Number.isInteger(value) && value > 0) {
                return value;
            }
        }

        // 最后兜底，仅从 body 中截取有限文本，避免整页 innerText 扫描过重
        const bodyText = document.body?.innerText?.slice(0, 50000) || '';
        const nums = bodyText.match(/\b\d{1,3}(?:,\d{3})+\b|\b\d+\b/g);
        if (nums?.length) {
            const candidates = nums
                .map(n => parseInt(n.replace(/,/g, ''), 10))
                .filter(n => Number.isInteger(n) && n > 0)
                .sort((a, b) => b - a);

            return candidates[0] || 0;
        }

        return 0;
    }

    function validateStartConfig(start, totalCount, waitSec) {
        if (!Number.isInteger(waitSec) || waitSec < CONFIG.NORMAL_DELAY_MIN_ALLOWED) {
            alert(`下载间隔最低可设 ${CONFIG.NORMAL_DELAY_MIN_ALLOWED} 秒；建议使用 ${CONFIG.NORMAL_DELAY_DEFAULT} 秒以提高稳定性`);
            return false;
        }
        if (!Number.isInteger(start) || start < 1) {
            alert('起始条目必须大于等于 1');
            return false;
        }
        if (!Number.isInteger(totalCount) || totalCount <= 0) {
            alert('未能识别记录总数，请等待页面完全加载后再试');
            return false;
        }
        if (start > totalCount) {
            alert('起始条目超过总数');
            return false;
        }
        if (start > CONFIG.MAX_ALLOWED_START) {
            alert(`接口上限为 ${CONFIG.MAX_HARD_STOP}，对应最大起始条目为 ${CONFIG.MAX_ALLOWED_START}。请拆分检索结果后再导出。`);
            return false;
        }
        return true;
    }

    async function fetchWithTimeout(url, options, timeoutMs) {
        const controller = new AbortController();
        runtime.currentFetchController = controller;

        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });

            if (!response.ok) {
                const text = await response.text().catch(() => '');
                const err = new Error(text || response.statusText || `HTTP ${response.status}`);
                err.status = response.status;
                err.statusText = response.statusText;
                throw err;
            }

            return response;
        } finally {
            clearTimeout(timeoutId);
            if (runtime.currentFetchController === controller) {
                runtime.currentFetchController = null;
            }
        }
    }

    async function doDownloadOnce(task, start, stop) {
        const payload = {
            parentQid: task.parentQid,
            sortBy: task.sortBy,
            displayTimesCited: 'true',
            displayCitedRefs: 'true',
            product: 'UA',
            colName: 'WOS',
            displayUsageInfo: 'true',
            fileOpt: getFileOptByFormat(task.fileFormat),
            action: getActionByFormat(task.fileFormat),
            markFrom: String(start),
            markTo: String(stop),
            view: 'summary',
            isRefQuery: 'false',
            locale: 'en_US',
            filters: getFiltersByFormat(task.fileFormat)
        };

        const response = await fetchWithTimeout(
            `${task.origin}/api/wosnx/indic/export/saveToFile`,
            {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'x-1p-wos-sid': getSessionID(),
                    'accept': 'application/json, text/plain, */*',
                    'content-type': 'application/json',
                    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
                },
                body: JSON.stringify(payload)
            },
            CONFIG.REQUEST_TIMEOUT_MS
        );

        return response.blob();
    }

    async function doDownloadWithRetry(task, start, stop) {
        let lastErr = null;

        for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
            try {
                return await doDownloadOnce(task, start, stop);
            } catch (err) {
                lastErr = err;
                if (!shouldRetry(err) || attempt >= CONFIG.MAX_RETRIES) break;

                const delay = CONFIG.RETRY_BASE_MS * (attempt + 1);
                log(`请求失败，准备重试 ${attempt + 1}/${CONFIG.MAX_RETRIES}：${start}-${stop}，${delay}ms 后继续`);
                await sleep(delay);
            }
        }

        throw lastErr;
    }

    async function startOrResumeTask(task) {
        if (!task) return;

        const sid = getSessionID();
        if (!sid) {
            markTaskStatus(task, TASK_STATUS.ERROR, '未能获取 Session ID，请刷新页面并确认已登录');
            alert('未能获取 Session ID，请刷新页面并确认已登录');
            return;
        }

        runtime.stopRequested = false;
        runtime.pauseRequested = false;

        setRuntimeTask(task);
        createControlPanel(task);

        task.status = TASK_STATUS.RUNNING;
        task.lastError = null;
        upsertTask(task);

        while (task.nextStart <= task.total) {
            if (task.nextStart > CONFIG.MAX_HARD_STOP) {
                markTaskStatus(task, TASK_STATUS.ERROR, `当前接口限制起始条目不能超过 ${CONFIG.MAX_HARD_STOP}`);
                clearRuntimeControls();
                enableMainButton('超过接口上限');
                alert(`当前接口限制起始条目不能超过 ${CONFIG.MAX_HARD_STOP}。`);
                return;
            }

            if (runtime.stopRequested) {
                finalizeStop(task);
                return;
            }

            if (runtime.pauseRequested) {
                markTaskStatus(task, TASK_STATUS.PAUSED);
                clearRuntimeControls();
                enableMainButton('继续下载');
                return;
            }

            const start = task.nextStart;
            const stop = getSafeStop(start, task.total, start + CONFIG.PAGE_SIZE - 1);
            task.nextStop = stop;
            upsertTask(task);

            disableMainButton(`${task.warmupMode ? '预热中' : '下载中'} ${start}-${stop}`);
            log(`${task.warmupMode ? '正在预热' : '正在下载'} ${start}-${stop} / ${task.total}`);

            try {
                const blob = await doDownloadWithRetry(task, start, stop);

                if (runtime.stopRequested) {
                    finalizeStop(task);
                    return;
                }

                if (!task.warmupMode) {
                    downloadBlob(buildDownloadFileName(task, start, stop), blob);
                    task.lastSuccessStart = start;
                    task.lastSuccessStop = stop;
                    task.completedRanges.push({ start, stop });
                }

                task.lastError = null;

                if (task.warmupMode) {
                    const nextCandidate = stop + 1;
                    if (nextCandidate >= task.requestedStart) {
                        task.warmupMode = false;
                        task.nextStart = task.requestedStart;
                    } else {
                        task.nextStart = nextCandidate;
                    }

                    task.nextStop = getSafeStop(task.nextStart, task.total, task.nextStart + CONFIG.PAGE_SIZE - 1);
                    upsertTask(task);

                    if (runtime.pauseRequested) {
                        markTaskStatus(task, TASK_STATUS.PAUSED);
                        clearRuntimeControls();
                        enableMainButton('继续下载');
                        return;
                    }

                    if (runtime.stopRequested) {
                        finalizeStop(task);
                        return;
                    }

                    const warmupDelay = randomInt(CONFIG.WARMUP_DELAY_MIN, CONFIG.WARMUP_DELAY_MAX);
                    disableMainButton(`预热等待 ${warmupDelay}s`);
                    log(`预热等待 ${warmupDelay} 秒后继续...`);
                    await sleep(warmupDelay * 1000);
                    continue;
                }

                task.nextStart = stop + 1;
                task.nextStop = getSafeStop(task.nextStart, task.total, task.nextStart + CONFIG.PAGE_SIZE - 1);
                upsertTask(task);

                if (task.nextStart > task.total || task.nextStart > CONFIG.MAX_HARD_STOP) {
                    markTaskStatus(task, TASK_STATUS.COMPLETED);
                    clearRuntimeControls();
                    alert('下载完成');
                    return;
                }

                if (runtime.pauseRequested) {
                    markTaskStatus(task, TASK_STATUS.PAUSED);
                    clearRuntimeControls();
                    enableMainButton('继续下载');
                    return;
                }

                if (runtime.stopRequested) {
                    finalizeStop(task);
                    return;
                }

                const minVal = Math.max(CONFIG.NORMAL_DELAY_MIN_ALLOWED, task.waitSecond - 5);
                const maxVal = Math.max(minVal, task.waitSecond + 5);
                const delay = randomInt(minVal, maxVal);

                disableMainButton(`等待 ${delay}s`);
                log(`等待 ${delay} 秒后继续下载...`);
                await sleep(delay * 1000);

            } catch (err) {
                if (runtime.stopRequested || err.name === 'AbortError') {
                    finalizeStop(task, false);
                    return;
                }

                const msg = formatError(err, task.warmupMode ? '预热出错' : '下载出错');
                console.error(err);
                markTaskStatus(task, TASK_STATUS.ERROR, msg);
                clearRuntimeControls();
                enableMainButton('恢复下载');
                alert(msg);
                return;
            }
        }

        markTaskStatus(task, TASK_STATUS.COMPLETED);
        clearRuntimeControls();
        alert('下载完成');
    }

    async function resumeTask() {
        const task = loadTask();
        if (!task) {
            alert('没有可恢复的任务');
            return;
        }

        if (task.parentQid !== getParentQid() || task.sortBy !== getSortBy()) {
            alert('当前页面与任务记录不匹配，不能恢复');
            return;
        }

        await startOrResumeTask(task);
    }

    function createPopup() {
        removePopup();

        const popup = dom.create('div', {
            id: CONFIG.POPUP_ID,
            className: 'wdb-popup'
        });

        popup.innerHTML = `
            <h3 style="margin-top:0;">一键下载</h3>

            <div class="wdb-field">
                <label for="fileFormat">文件格式：</label>
                <select id="fileFormat">
                    <option value="ris">RIS</option>
                    <option value="bibtex">BibTeX</option>
                    <option value="txt">TXT</option>
                </select>
            </div>

            <div class="wdb-field">
                <label for="startDownloadFrom">起始条目：</label>
                <input type="number" id="startDownloadFrom" value="1" min="1" max="${CONFIG.MAX_ALLOWED_START}">
                <div class="wdb-muted">
                    每次导出 500 条全记录（含引用文献）。<br>
                    接口上限 ${CONFIG.MAX_HARD_STOP}，对应最大起始为 ${CONFIG.MAX_ALLOWED_START}。<br>
                    建议不要超过 100000，对应起始为 ${CONFIG.RECOMMENDED_DIRECT_START_MAX}。<br>
                    若起始条目大于 ${CONFIG.RECOMMENDED_DIRECT_START_MAX}，脚本会先自动预热（期间不保存文件）。
                </div>
            </div>

            <div class="wdb-field" style="margin-bottom:16px;">
                <label for="downloadSpeed">下载间隔（秒）：</label>
                <input type="number" id="downloadSpeed" value="${CONFIG.NORMAL_DELAY_DEFAULT}" min="${CONFIG.NORMAL_DELAY_MIN_ALLOWED}">
                <div class="wdb-muted">
                    最低可设 ${CONFIG.NORMAL_DELAY_MIN_ALLOWED} 秒；建议使用 ${CONFIG.NORMAL_DELAY_DEFAULT} 秒以提高稳定性。
                </div>
            </div>

            <div class="wdb-actions">
                <button id="confirmButton">开始下载</button>
                <button id="cancelButton">取消</button>
            </div>
        `;

        document.body.appendChild(popup);

        dom.byId('cancelButton')?.addEventListener('click', removePopup);

        dom.byId('confirmButton')?.addEventListener('click', async () => {
            const sid = getSessionID();
            const parentQid = getParentQid();
            const total = getTotal();
            const waitSecond = parseInt(dom.byId('downloadSpeed')?.value || '', 10);
            const fileFormat = String(dom.byId('fileFormat')?.value || 'ris');
            const start = parseInt(dom.byId('startDownloadFrom')?.value || '', 10);

            log('下载间隔:', waitSecond);
            log('文件格式:', fileFormat);
            log('起始条目:', start);
            log('wosSid:', sid);
            log('uuid:', parentQid);
            log('总数:', total);
            log('sortBy:', getSortBy());

            if (!parentQid) {
                alert('未能识别 parentQid，当前页面可能不受支持');
                return;
            }

            if (!sid) {
                alert('未能获取 Session ID，请先确认已正常登录 WoS，并刷新页面后再试');
                return;
            }

            if (!validateStartConfig(start, total, waitSecond)) {
                return;
            }

            const task = createTask({
                start,
                totalCount: total,
                fileFormat,
                waitSecond
            });

            removePopup();
            upsertTask(task);
            createControlPanel(task);
            await startOrResumeTask(task);
        });
    }

    async function mainButtonClick() {
        const task = loadTask();

        if (task?.status === TASK_STATUS.PAUSED || task?.status === TASK_STATUS.ERROR) {
            await resumeTask();
            return;
        }

        if (task?.status === TASK_STATUS.RUNNING) {
            alert('当前已有任务在运行，请使用右侧控制台进行暂停或停止');
            return;
        }

        createPopup();
    }

    function initMainButton() {
        if (!isSupportedPage()) return;
        if (dom.byId(CONFIG.MAIN_BUTTON_ID)) return;

        ensureStyle();

        const btn = dom.create('button', {
            id: CONFIG.MAIN_BUTTON_ID,
            type: 'button'
        });
        btn.textContent = '一键下载';
        btn.addEventListener('click', mainButtonClick);

        document.body.appendChild(btn);
        updateMainButton();
        log('主按钮已初始化');
    }

    function removeUiIfNeeded() {
        if (isSupportedPage()) return;
        dom.remove(CONFIG.MAIN_BUTTON_ID);
        removePopup();
        removeControlPanel();
    }

    function debounce(fn, delay) {
        let timer = null;
        return (...args) => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
    }

    function handleUrlChange() {
        removeUiIfNeeded();
        if (isSupportedPage()) {
            initMainButton();
            autoResumePrompt();
        }
    }

    function observeUrlChange() {
        let lastUrl = location.href;
        const onChange = debounce(() => {
            const currentUrl = location.href;
            if (currentUrl === lastUrl) {
                if (isSupportedPage() && !dom.byId(CONFIG.MAIN_BUTTON_ID)) {
                    initMainButton();
                }
                return;
            }

            lastUrl = currentUrl;
            runtime.autoResumeAsked = false;
            log('检测到 URL 变化：', currentUrl);
            handleUrlChange();
        }, 500);

        const rawPushState = history.pushState;
        const rawReplaceState = history.replaceState;

        history.pushState = function (...args) {
            rawPushState.apply(this, args);
            onChange();
        };

        history.replaceState = function (...args) {
            rawReplaceState.apply(this, args);
            onChange();
        };

        window.addEventListener('popstate', onChange);

        if (runtime.observer) runtime.observer.disconnect();
        runtime.observer = new MutationObserver(onChange);
        runtime.observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    async function autoResumePrompt() {
        if (!isSupportedPage() || runtime.autoResumeAsked) return;

        const task = loadTask();
        if (!task) return;
        if (task.parentQid !== getParentQid() || task.sortBy !== getSortBy()) return;

        runtime.autoResumeAsked = true;

        setRuntimeTask(task);
        createControlPanel(task);
        updateMainButton();

        if (task.status === TASK_STATUS.RUNNING) {
            task.status = TASK_STATUS.PAUSED;
            upsertTask(task);
        }

        if (task.status === TASK_STATUS.PAUSED || task.status === TASK_STATUS.ERROR) {
            setTimeout(async () => {
                const yes = confirm(`检测到未完成下载任务（进度 ${getProgressText(task)}），是否继续？`);
                if (yes) {
                    await resumeTask();
                }
            }, 800);
        }
    }

    function init() {
        log(`WDB-v${CONFIG.VERSION}`);
        ensureStyle();

        if (isSupportedPage()) {
            initMainButton();
            autoResumePrompt();
        }

        observeUrlChange();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();