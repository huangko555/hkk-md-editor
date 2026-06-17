// HKK 颜色色块预览:#hex 前面插内联圆点 (像 VS Code 原生 Monaco)
//
// 关键设计 (经过多轮血战定下来的安全模式):
//
// 1. 只在"安全块"里显示色块 (跟原生 VS Code 一致):
//      ✓ <p>     正文段落
//      ✓ <h1-6>  标题
//      ✓ <pre>   代码块
//      ✗ <li> <td> <th> <blockquote> <tr>  vditor 对这些容器内的 span 处理脆弱
//        塞 swatch 进去会让 vditor 序列化时把整段 hex 文本吞掉
//
// 2. 重画粒度:**永远只动当前那个 block**,绝不扫全文
//      → 用户在 block A 编辑时,绝不会影响 block B 的 DOM
//      → 即使本 block 出问题,也波及不了别的 block
//
// 3. MutationObserver 200ms 防抖:让 vditor 自己的序列化先完成,我再动 DOM
//      → 不会跟 vditor 的输入处理打架
//
// 4. 围绕 attach 的 observer disconnect/reconnect:防自激
(function () {
    const SWATCH_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
    const VP_BUFFER = 1200;
    const ALLOWED_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, pre';
    const DISALLOWED_ANCESTOR_SELECTOR = 'li, td, th, blockquote, tr';
    const DEBOUNCE_MS = 200;

    let observer = null;
    let mutationDebounce = null;
    const pendingBlocks = new Set();
    let lastCursorBlock = null;

    function getEditorRoot() {
        return document.querySelector('.vditor-wysiwyg, .vditor-ir, .vditor-sv');
    }

    function inViewport(el) {
        const r = el.getBoundingClientRect();
        const winH = window.innerHeight || document.documentElement.clientHeight;
        return r.bottom >= -VP_BUFFER && r.top <= winH + VP_BUFFER;
    }

    function isAllowed(block) {
        if (!block || !block.matches) return false;
        if (!block.matches(ALLOWED_SELECTOR)) return false;
        if (block.closest(DISALLOWED_ANCESTOR_SELECTOR)) return false;
        return true;
    }

    function findAllowedBlock(node) {
        let e = node && node.nodeType === Node.ELEMENT_NODE ? node : (node && node.parentElement);
        const root = getEditorRoot();
        while (e && e !== root && e.tagName !== 'BODY') {
            if (isAllowed(e)) return e;
            e = e.parentElement;
        }
        return null;
    }

    function getCursorBlock() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return null;
        return findAllowedBlock(sel.getRangeAt(0).startContainer);
    }

    function attachBlock(block) {
        if (!isAllowed(block)) return;
        if (!inViewport(block)) {
            // 视口外:清掉现有 swatch,不重新插
            block.querySelectorAll('.vmd-color-swatch').forEach(s => s.remove());
            return;
        }

        // 清旧
        block.querySelectorAll('.vmd-color-swatch').forEach(s => s.remove());

        // 收文本节点拼成连续文本 (hljs 会拆成多 token,单节点匹配会漏)
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let full = '';
        let n;
        while ((n = walker.nextNode())) {
            const txt = n.textContent || '';
            if (!txt) continue;
            const parent = n.parentElement;
            if (!parent) continue;
            if (parent.closest('.vditor-ir__marker')) continue;
            if (parent.closest('.vditor-ir__marker--pre')) continue;
            if (parent.closest('.vmd-color-swatch')) continue;
            nodes.push({ node: n, start: full.length, len: txt.length });
            full += txt;
        }
        if (full.indexOf('#') < 0) return;

        const matches = Array.from(full.matchAll(SWATCH_RE));
        for (let i = matches.length - 1; i >= 0; i--) {
            const gIdx = matches[i].index || 0;
            const color = matches[i][0];
            let lo = 0, hi = nodes.length - 1, ni = -1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const s = nodes[mid].start;
                if (gIdx < s) hi = mid - 1;
                else if (gIdx >= s + nodes[mid].len) lo = mid + 1;
                else { ni = mid; break; }
            }
            if (ni < 0) continue;
            const tn = nodes[ni].node;
            const local = gIdx - nodes[ni].start;
            const after = local === 0 ? tn : tn.splitText(local);
            const sw = document.createElement('span');
            sw.className = 'vmd-color-swatch';
            sw.setAttribute('contenteditable', 'false');
            sw.setAttribute('aria-hidden', 'true');
            sw.style.setProperty('background-color', color, 'important');
            if (after.parentNode) after.parentNode.insertBefore(sw, after);
        }
    }

    function attachAll(root) {
        const blocks = root.querySelectorAll(ALLOWED_SELECTOR);
        for (const block of blocks) {
            try { attachBlock(block); } catch (e) { /* skip */ }
        }
    }

    // 围绕实际 DOM 改动 disconnect/reconnect,防止 attach 自己引起的 mutation 触发自激循环
    function withObserverPaused(fn) {
        const root = getEditorRoot();
        if (observer) observer.disconnect();
        try { fn(); } catch (e) { console.error('[hkk-swatch]', e); }
        if (observer && root) observer.observe(root, { childList: true, subtree: true, characterData: true });
    }

    function init() {
        const tryStart = () => {
            const root = getEditorRoot();
            if (!root) return false;

            // MutationObserver:收集受影响的 allowed block,防抖 200ms 后逐 block 重画
            // 在 LI / TD / BLOCKQUOTE 内的改动 → findAllowedBlock 返回 null → 不进 pendingBlocks
            // → 那些容器内的编辑跟我完全无关,vditor 自己怎么序列化都行
            observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    const block = findAllowedBlock(m.target);
                    if (block) pendingBlocks.add(block);
                }
                if (pendingBlocks.size === 0) return;
                if (mutationDebounce) clearTimeout(mutationDebounce);
                mutationDebounce = setTimeout(() => {
                    withObserverPaused(() => {
                        for (const block of pendingBlocks) {
                            if (document.contains(block)) attachBlock(block);
                        }
                    });
                    pendingBlocks.clear();
                }, DEBOUNCE_MS);
            });
            observer.observe(root, { childList: true, subtree: true, characterData: true });

            // selectionchange:光标跨 block 时,旧 block 和新 block 各重画一次
            let selTimer;
            document.addEventListener('selectionchange', () => {
                if (selTimer) clearTimeout(selTimer);
                selTimer = setTimeout(() => {
                    const curr = getCursorBlock();
                    if (curr === lastCursorBlock) return;
                    withObserverPaused(() => {
                        if (lastCursorBlock && document.contains(lastCursorBlock)) attachBlock(lastCursorBlock);
                        if (curr) attachBlock(curr);
                    });
                    lastCursorBlock = curr;
                }, 120);
            });

            // 滚动/缩放:视口变了,重画全部 allowed blocks
            let scrollTimer;
            const onScroll = () => {
                if (scrollTimer) clearTimeout(scrollTimer);
                scrollTimer = setTimeout(() => {
                    withObserverPaused(() => attachAll(root));
                }, 200);
            };
            window.addEventListener('scroll', onScroll, true);
            window.addEventListener('resize', onScroll);

            // 初始 3 次保险
            const initialAttach = () => withObserverPaused(() => attachAll(root));
            initialAttach();
            setTimeout(initialAttach, 500);
            setTimeout(initialAttach, 1500);
            return true;
        };
        let tries = 0;
        const retry = () => {
            if (tryStart()) return;
            tries++;
            if (tries < 30) setTimeout(retry, 300);
        };
        retry();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
