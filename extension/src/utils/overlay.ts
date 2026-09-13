import { sendMessage } from '@/utils/messaging';
import { overlayEnabledItem, themeItem } from '@/utils/storage';
import { overlayStyles } from '@/utils/overlay-styles';
import { DOMTextMatcher } from '@/utils/text-matcher';
import type { Annotation } from '@/utils/types';
import { APP_URL } from '@/utils/types';

const Icons = {
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
  reply: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>`,
  share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  highlightMarker: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>`,
  message: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
};

function formatRelativeTime(dateString: string) {
  const date = new Date(dateString);
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) return 'just now';
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h`;
  if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)}d`;
  return date.toLocaleDateString();
}

function escapeHtml(unsafe: string) {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  return ((...args: any[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}

export async function initContentScript(ctx: { onInvalidated: (cb: () => void) => void }) {
  let overlayHost: HTMLElement | null = null;
  let shadowRoot: ShadowRoot | null = null;
  let popoverEl: HTMLElement | null = null;
  let hoverIndicator: HTMLElement | null = null;
  let composeModal: HTMLElement | null = null;
  let activeItems: Array<{ range: Range; item: Annotation }> = [];
  let cachedMatcher: DOMTextMatcher | null = null;
  let matcherNeedsRebuild = false;
  const injectedStyles = new Set<string>();
  const ownedHighlights = new Set<string>();
  let overlayEnabled = true;
  let currentUserDid: string | null = null;
  let cachedUserTags: string[] = [];

  function setHighlight(name: string, highlight: Highlight) {
    CSS.highlights.set(name, highlight);
    ownedHighlights.add(name);
  }

  function deleteHighlight(name: string) {
    CSS.highlights.delete(name);
    ownedHighlights.delete(name);
  }

  function clearOwnHighlights() {
    if (typeof CSS === 'undefined' || !CSS.highlights) return;
    for (const name of ownedHighlights) CSS.highlights.delete(name);
    ownedHighlights.clear();
  }

  function getPageUrl(): string {
    const pdfUrl = document.documentElement.dataset.marginPdfUrl;
    if (pdfUrl) return pdfUrl;

    if (window.location.href.includes('/pdfjs/web/viewer.html')) {
      try {
        const params = new URLSearchParams(window.location.search);
        const fileParam = params.get('file');
        if (fileParam) {
          document.documentElement.dataset.marginPdfUrl = fileParam;
          return fileParam;
        }
      } catch {
        /* ignore */
      }
    }

    return window.location.href;
  }

  function getPageDOIUrl(): string | null {
    try {
      if (new URL(window.location.href).hostname === 'doi.org') return null;
    } catch {
      return null;
    }

    const metaDOI =
      document.querySelector<HTMLMetaElement>('meta[name="citation_doi"]') ||
      document.querySelector<HTMLMetaElement>('meta[name="dc.identifier"]') ||
      document.querySelector<HTMLMetaElement>('meta[name="DC.identifier"]');
    if (metaDOI?.content) {
      const doi = metaDOI.content.replace(/^doi:/i, '').trim();
      if (doi.startsWith('10.')) return `https://doi.org/${doi}`;
    }

    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (canonical?.href) {
      try {
        if (new URL(canonical.href).hostname === 'doi.org') return canonical.href;
      } catch {
        /* ignore */
      }
    }

    return null;
  }

  function getPageCiteUrls(): string[] {
    const urls = new Set<string>();
    document.querySelectorAll<Element>('q[cite], blockquote[cite]').forEach((el) => {
      const cite = el.getAttribute('cite');
      if (!cite) return;
      try {
        const abs = new URL(cite, window.location.href).href;
        if (abs !== window.location.href) urls.add(abs);
      } catch {
        /* ignore */
      }
    });
    return Array.from(urls);
  }

  function getCiteUrlForText(text: string): string | null {
    if (!text) return null;
    if (!cachedMatcher || matcherNeedsRebuild) {
      cachedMatcher = new DOMTextMatcher();
      matcherNeedsRebuild = false;
    }
    const range = cachedMatcher.findRange(text);
    if (!range) return null;

    let node: Node | null = range.commonAncestorContainer;
    while (node && node !== document.body) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if ((el.tagName === 'Q' || el.tagName === 'BLOCKQUOTE') && el.hasAttribute('cite')) {
          const cite = el.getAttribute('cite')!;
          try {
            return new URL(cite, window.location.href).href;
          } catch {
            return null;
          }
        }
      }
      node = node.parentNode;
    }
    return null;
  }

  function isPdfContext(): boolean {
    return !!(
      document.querySelector('.pdfViewer') ||
      window.location.href.includes('/pdfjs/web/viewer.html')
    );
  }

  sendMessage('checkSession', undefined)
    .then((session) => {
      if (session.authenticated && session.did) {
        currentUserDid = session.did;
        Promise.all([
          sendMessage('getUserTags', { did: session.did }).catch(() => [] as string[]),
          sendMessage('getTrendingTags', undefined).catch(() => [] as string[]),
        ]).then(([userTags, trendingTags]) => {
          const seen = new Set(userTags);
          cachedUserTags = [...userTags];
          for (const t of trendingTags) {
            if (!seen.has(t)) {
              cachedUserTags.push(t);
              seen.add(t);
            }
          }
        });
      }
    })
    .catch(() => {});

  function initOverlay() {
    overlayHost = document.createElement('div');
    overlayHost.id = 'margin-overlay-host';
    overlayHost.style.cssText = `
        position: absolute; top: 0; left: 0; width: 100%; 
        height: 0; overflow: visible;
        pointer-events: none; z-index: 2147483647;
      `;
    if (document.body) {
      document.body.appendChild(overlayHost);
    } else {
      document.documentElement.appendChild(overlayHost);
    }

    shadowRoot = overlayHost.attachShadow({ mode: 'open' });

    const styleEl = document.createElement('style');
    styleEl.textContent = overlayStyles;
    shadowRoot.appendChild(styleEl);
    const overlayContainer = document.createElement('div');
    overlayContainer.className = 'margin-overlay';
    overlayContainer.id = 'margin-overlay-container';
    shadowRoot.appendChild(overlayContainer);

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('click', handleDocumentClick, true);
    document.addEventListener('keydown', handleKeyDown);
  }
  if (document.body) {
    initOverlay();
  } else {
    document.addEventListener('DOMContentLoaded', initOverlay);
  }

  overlayEnabledItem.getValue().then((enabled) => {
    overlayEnabled = enabled;
    if (!enabled && overlayHost) {
      overlayHost.style.display = 'none';
      sendMessage('updateBadge', { count: 0 });
    } else {
      applyTheme();
      setTimeout(() => fetchAnnotations(), 100);
    }
  });

  ctx.onInvalidated(() => {
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('click', handleDocumentClick, true);
    document.removeEventListener('keydown', handleKeyDown);

    overlayHost?.remove();
  });

  async function applyTheme() {
    if (!overlayHost) return;
    const theme = await themeItem.getValue();
    overlayHost.classList.remove('light', 'dark');
    if (theme === 'system' || !theme) {
      if (window.matchMedia('(prefers-color-scheme: light)').matches) {
        overlayHost.classList.add('light');
      }
    } else {
      overlayHost.classList.add(theme);
    }
  }

  themeItem.watch((newTheme) => {
    if (overlayHost) {
      overlayHost.classList.remove('light', 'dark');
      if (newTheme === 'system') {
        if (window.matchMedia('(prefers-color-scheme: light)').matches) {
          overlayHost.classList.add('light');
        }
      } else {
        overlayHost.classList.add(newTheme);
      }
    }
  });

  overlayEnabledItem.watch((enabled) => {
    overlayEnabled = enabled;
    if (overlayHost) {
      overlayHost.style.display = enabled ? '' : 'none';
      if (enabled) {
        fetchAnnotations();
      } else {
        activeItems = [];
        clearOwnHighlights();
        sendMessage('updateBadge', { count: 0 });
      }
    }
  });

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (composeModal) {
        composeModal.remove();
        composeModal = null;
      }
      if (popoverEl) {
        popoverEl.remove();
        popoverEl = null;
      }
    }
  }

  function getSelectionContext(exact: string): { prefix?: string; suffix?: string } {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return {};
    const range = sel.getRangeAt(0);
    if (sel.toString().trim() !== exact.trim()) return {};

    try {
      const prefixRange = document.createRange();
      prefixRange.setStart(range.startContainer, 0);
      prefixRange.setEnd(range.startContainer, range.startOffset);
      const rawPrefix = prefixRange.toString();
      const prefix = rawPrefix.length > 0 ? rawPrefix.slice(-150) : undefined;

      const endNode = range.endContainer;
      const endLen =
        endNode.nodeType === Node.TEXT_NODE
          ? (endNode as Text).length
          : ((endNode as Element).textContent?.length ?? 0);
      const suffixRange = document.createRange();
      suffixRange.setStart(range.endContainer, range.endOffset);
      suffixRange.setEnd(range.endContainer, endLen);
      const rawSuffix = suffixRange.toString();
      const suffix = rawSuffix.length > 0 ? rawSuffix.slice(0, 150) : undefined;

      return { prefix: prefix || undefined, suffix: suffix || undefined };
    } catch {
      return {};
    }
  }

  function showComposeModal(
    quoteText: string,
    selectorContext?: { prefix?: string; suffix?: string }
  ) {
    if (!shadowRoot) return;

    const container = shadowRoot.getElementById('margin-overlay-container');
    if (!container) return;

    if (composeModal) composeModal.remove();

    composeModal = document.createElement('div');
    composeModal.className = 'inline-compose-modal';

    const left = Math.max(20, (window.innerWidth - 380) / 2);
    const top = Math.max(60, window.innerHeight * 0.2);

    composeModal.style.left = `${left}px`;
    composeModal.style.top = `${top}px`;

    const truncatedQuote = quoteText.length > 150 ? quoteText.slice(0, 150) + '...' : quoteText;

    const header = document.createElement('div');
    header.className = 'compose-header';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'compose-title';
    titleSpan.textContent = 'New Annotation';
    header.appendChild(titleSpan);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'compose-close';
    closeBtn.innerHTML = Icons.close;
    header.appendChild(closeBtn);

    composeModal.appendChild(header);

    const body = document.createElement('div');
    body.className = 'compose-body';

    const quoteDiv = document.createElement('div');
    quoteDiv.className = 'inline-compose-quote';
    quoteDiv.textContent = `"${truncatedQuote}"`;
    body.appendChild(quoteDiv);

    const textarea = document.createElement('textarea');
    textarea.className = 'inline-compose-textarea';
    textarea.placeholder = 'Write your annotation...';
    body.appendChild(textarea);

    const tagSection = document.createElement('div');
    tagSection.className = 'compose-tags-section';

    const tagContainer = document.createElement('div');
    tagContainer.className = 'compose-tags-container';

    const tagInput = document.createElement('input');
    tagInput.type = 'text';
    tagInput.className = 'compose-tag-input';
    tagInput.placeholder = 'Add tags...';

    const tagSuggestionsDropdown = document.createElement('div');
    tagSuggestionsDropdown.className = 'compose-tag-suggestions';
    tagSuggestionsDropdown.style.display = 'none';

    const composeTags: string[] = [];

    function renderTags() {
      tagContainer.querySelectorAll('.compose-tag-pill').forEach((el) => el.remove());
      composeTags.forEach((tag) => {
        const pill = document.createElement('span');
        pill.className = 'compose-tag-pill';
        pill.innerHTML = `${escapeHtml(tag)} <button class="compose-tag-remove">${Icons.close}</button>`;
        pill.querySelector('.compose-tag-remove')?.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = composeTags.indexOf(tag);
          if (idx > -1) composeTags.splice(idx, 1);
          renderTags();
        });
        tagContainer.insertBefore(pill, tagInput);
      });
      tagInput.placeholder = composeTags.length === 0 ? 'Add tags...' : '';
    }

    function addComposeTag(tag: string) {
      const normalized = tag
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '');
      if (normalized && !composeTags.includes(normalized) && composeTags.length < 10) {
        composeTags.push(normalized);
        renderTags();
      }
      tagInput.value = '';
      tagSuggestionsDropdown.style.display = 'none';
      tagInput.focus();
    }

    function showTagSuggestions() {
      const query = tagInput.value.trim().toLowerCase();
      if (!query) {
        tagSuggestionsDropdown.style.display = 'none';
        return;
      }
      const matches = cachedUserTags
        .filter((t) => t.toLowerCase().includes(query) && !composeTags.includes(t))
        .slice(0, 6);
      if (matches.length === 0) {
        tagSuggestionsDropdown.style.display = 'none';
        return;
      }
      tagSuggestionsDropdown.innerHTML = matches
        .map((t) => `<button class="compose-tag-suggestion-item">${escapeHtml(t)}</button>`)
        .join('');
      tagSuggestionsDropdown.style.display = 'block';
      tagSuggestionsDropdown.querySelectorAll('.compose-tag-suggestion-item').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          addComposeTag(btn.textContent || '');
        });
      });
    }

    tagInput.addEventListener('input', debounce(showTagSuggestions, 120));
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        if (tagInput.value.trim()) addComposeTag(tagInput.value);
      } else if (e.key === 'Backspace' && !tagInput.value && composeTags.length > 0) {
        composeTags.pop();
        renderTags();
      } else if (e.key === 'Escape') {
        tagSuggestionsDropdown.style.display = 'none';
      }
    });

    tagContainer.appendChild(tagInput);
    tagSection.appendChild(tagContainer);
    tagSection.appendChild(tagSuggestionsDropdown);
    body.appendChild(tagSection);

    composeModal.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'compose-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-cancel';
    cancelBtn.textContent = 'Cancel';
    footer.appendChild(cancelBtn);

    const submitBtn = document.createElement('button');
    submitBtn.className = 'btn-submit';
    submitBtn.textContent = 'Post';
    footer.appendChild(submitBtn);

    composeModal.appendChild(footer);

    composeModal.querySelector('.compose-close')?.addEventListener('click', () => {
      composeModal?.remove();
      composeModal = null;
    });

    cancelBtn.addEventListener('click', () => {
      composeModal?.remove();
      composeModal = null;
    });

    submitBtn.addEventListener('click', async () => {
      const text = textarea?.value.trim();
      if (!text) return;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Posting...';

      try {
        const citeUrl = getCiteUrlForText(quoteText);
        const selector = {
          type: 'TextQuoteSelector',
          exact: quoteText,
          prefix: selectorContext?.prefix,
          suffix: selectorContext?.suffix,
        };
        const res = await sendMessage('createAnnotation', {
          url: citeUrl || getPageUrl(),
          title: document.title,
          text,
          selector,
          tags: composeTags.length > 0 ? composeTags : undefined,
        });

        if (!res.success) {
          throw new Error(res.error || 'Unknown error');
        }

        showToast('Annotation created!', 'success');
        composeModal?.remove();
        composeModal = null;

        setTimeout(() => fetchAnnotations(0, true), 500);
      } catch (error) {
        console.error('Failed to create annotation:', error);
        showToast('Failed to create annotation', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Post';
      }
    });

    container.appendChild(composeModal);
    setTimeout(() => textarea?.focus(), 100);
  }
  browser.runtime.onMessage.addListener((message: any) => {
    if (message.type === 'SHOW_INLINE_ANNOTATE' && message.data?.selector?.exact) {
      const exact = message.data.selector.exact as string;
      showComposeModal(exact, getSelectionContext(exact));
    }
    if (message.type === 'REFRESH_ANNOTATIONS') {
      fetchAnnotations(0, true);
    }
    if (message.type === 'SHOW_TAG_INPUT' && message.uri) {
      showTagToast(message.uri);
    }
    if (message.type === 'SCROLL_TO_TEXT' && message.text) {
      scrollToText(message.text);
    }
    if (message.type === 'GET_SELECTION') {
      const selection = window.getSelection();
      const text = selection?.toString().trim() || '';
      const context = text ? getSelectionContext(text) : {};
      return Promise.resolve({ text, ...context });
    }
    if (message.type === 'GET_DOI') {
      return Promise.resolve({ doiUrl: getPageDOIUrl() });
    }
    if (message.type === 'GET_CITE_URL') {
      return Promise.resolve({ citeUrl: getCiteUrlForText(message.text || '') });
    }
  });

  function scrollToText(text: string) {
    if (!text || text.length < 3) return;

    if (!cachedMatcher || matcherNeedsRebuild) {
      cachedMatcher = new DOMTextMatcher();
      matcherNeedsRebuild = false;
    }

    const range = cachedMatcher.findRange(text);
    if (!range) return;

    const rect = range.getBoundingClientRect();
    const scrollY = window.scrollY + rect.top - window.innerHeight / 3;
    window.scrollTo({ top: scrollY, behavior: 'smooth' });

    if (typeof CSS !== 'undefined' && CSS.highlights) {
      const tempHighlight = new Highlight(range);
      const hlName = 'margin-scroll-flash';
      setHighlight(hlName, tempHighlight);
      injectHighlightStyle(hlName, '#3b82f6');

      const flashStyle = document.createElement('style');
      flashStyle.textContent = `::highlight(${hlName}) {
          background-color: rgba(99, 102, 241, 0.25);
          text-decoration: underline;
          text-decoration-color: #3b82f6;
          text-decoration-thickness: 3px;
          text-underline-offset: 2px;
        }`;
      document.head.appendChild(flashStyle);

      setTimeout(() => {
        deleteHighlight(hlName);
        flashStyle.remove();
      }, 2500);
    } else {
      try {
        const highlight = document.createElement('mark');
        highlight.style.cssText =
          'background: rgba(59, 130, 246, 0.25); color: inherit; padding: 2px 0; border-radius: 2px; text-decoration: underline; text-decoration-color: #3b82f6; text-decoration-thickness: 3px; transition: all 0.5s;';
        range.surroundContents(highlight);

        setTimeout(() => {
          highlight.style.background = 'transparent';
          highlight.style.textDecoration = 'none';
          setTimeout(() => {
            const parent = highlight.parentNode;
            if (parent) {
              parent.replaceChild(document.createTextNode(highlight.textContent || ''), highlight);
              parent.normalize();
            }
          }, 500);
        }, 2000);
      } catch {
        // ignore
      }
    }
  }

  function showToast(message: string, type: 'success' | 'error' = 'success') {
    if (!shadowRoot) return;

    const container = shadowRoot.getElementById('margin-overlay-container');
    if (!container) return;

    container.querySelectorAll('.margin-toast').forEach((el) => el.remove());

    const toast = document.createElement('div');
    toast.className = `margin-toast ${type === 'success' ? 'toast-success' : ''}`;
    const iconSpan = document.createElement('span');
    iconSpan.className = 'toast-icon';
    iconSpan.innerHTML = type === 'success' ? Icons.check : Icons.close;
    toast.appendChild(iconSpan);

    const msgSpan = document.createElement('span');
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 200);
    }, 2500);
  }

  function showTagToast(uri: string) {
    if (!shadowRoot) return;
    const container = shadowRoot.getElementById('margin-overlay-container');
    if (!container) return;

    container.querySelectorAll('.margin-tag-toast').forEach((el) => el.remove());

    const tags: string[] = [];
    const toast = document.createElement('div');
    toast.className = 'margin-tag-toast';
    toast.innerHTML = `
      <div class="tag-toast-header">
        <span>${Icons.check}</span>
        <span>Highlighted! Add tags?</span>
      </div>
      <div class="tag-toast-body">
        <div class="tag-toast-tags">
          <input type="text" class="tag-toast-input" placeholder="Type a tag and press Enter..." />
        </div>
        <div class="tag-toast-suggestions"></div>
      </div>
      <div class="tag-toast-actions">
        <button class="tag-toast-skip">Skip</button>
        <button class="tag-toast-save">Save</button>
      </div>
    `;
    container.appendChild(toast);

    const input = toast.querySelector('.tag-toast-input') as HTMLInputElement;
    const tagsWrapper = toast.querySelector('.tag-toast-tags') as HTMLElement;
    const suggestionsEl = toast.querySelector('.tag-toast-suggestions') as HTMLElement;
    const saveBtn = toast.querySelector('.tag-toast-save') as HTMLButtonElement;
    const skipBtn = toast.querySelector('.tag-toast-skip') as HTMLButtonElement;

    function renderTags() {
      tagsWrapper.querySelectorAll('.tag-toast-pill').forEach((el) => el.remove());
      tags.forEach((t) => {
        const pill = document.createElement('span');
        pill.className = 'tag-toast-pill';
        pill.innerHTML = `${escapeHtml(t)} <button data-tag="${escapeHtml(t)}">&times;</button>`;
        pill.querySelector('button')!.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = tags.indexOf(t);
          if (idx !== -1) tags.splice(idx, 1);
          renderTags();
          input.focus();
        });
        tagsWrapper.insertBefore(pill, input);
      });
      input.placeholder = tags.length === 0 ? 'Type a tag and press Enter...' : '';
    }

    function addTag(val: string) {
      const normalized = val
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '');
      if (normalized && !tags.includes(normalized) && tags.length < 10) {
        tags.push(normalized);
        renderTags();
      }
      input.value = '';
      suggestionsEl.style.display = 'none';
    }

    tagsWrapper.addEventListener('click', () => input.focus());

    input.addEventListener('keydown', (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Enter' || ke.key === ',') {
        ke.preventDefault();
        ke.stopPropagation();
        if (input.value.trim()) addTag(input.value);
      } else if (ke.key === 'Backspace' && !input.value && tags.length > 0) {
        tags.pop();
        renderTags();
      }
    });

    input.addEventListener(
      'input',
      debounce(() => {
        const val = input.value.toLowerCase().trim();
        if (!val) {
          suggestionsEl.style.display = 'none';
          return;
        }
        const matches = cachedUserTags.filter((t) => t.includes(val) && !tags.includes(t));
        if (matches.length === 0) {
          suggestionsEl.style.display = 'none';
          return;
        }
        suggestionsEl.innerHTML = matches
          .slice(0, 5)
          .map((t) => `<button class="tag-suggestion-btn">${escapeHtml(t)}</button>`)
          .join('');
        suggestionsEl.style.display = 'flex';
        suggestionsEl.querySelectorAll('.tag-suggestion-btn').forEach((btn) => {
          btn.addEventListener('click', () => addTag(btn.textContent || ''));
        });
      }, 120)
    );

    function dismiss() {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 200);
    }

    skipBtn.addEventListener('click', dismiss);

    saveBtn.addEventListener('click', async () => {
      if (tags.length === 0) {
        dismiss();
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        await sendMessage('updateHighlightTags', { uri, tags });
        showToast('Tags added!', 'success');
      } catch {
        showToast('Failed to save tags', 'error');
      }
      dismiss();
    });

    setTimeout(() => input.focus(), 50);
  }

  let isFetching = false;

  async function fetchAnnotations(retryCount = 0, cacheBust = false) {
    if (!overlayEnabled) {
      sendMessage('updateBadge', { count: 0 });
      return;
    }

    if (isFetching && !cacheBust) return;
    isFetching = true;

    try {
      const pageUrl = getPageUrl();
      const doiUrl = getPageDOIUrl();
      const citeUrls = getPageCiteUrls();
      const citedUrls = [...(doiUrl ? [doiUrl] : []), ...citeUrls];

      const annotations = await sendMessage('getAnnotations', {
        url: pageUrl,
        citedUrls,
        cacheBust,
      });

      sendMessage('updateBadge', { count: annotations?.length || 0 });

      if (annotations) {
        sendMessage('cacheAnnotations', { url: pageUrl, annotations });
      }

      if (annotations && annotations.length > 0) {
        renderBadges(annotations);
      } else if (retryCount < 3) {
        setTimeout(() => fetchAnnotations(retryCount + 1, cacheBust), 1000 * (retryCount + 1));
      }
    } catch (error) {
      console.error('Failed to fetch annotations:', error);
      if (retryCount < 3) {
        setTimeout(() => fetchAnnotations(retryCount + 1, cacheBust), 1000 * (retryCount + 1));
      }
    } finally {
      isFetching = false;
    }
  }

  function renderBadges(annotations: Annotation[]) {
    if (!shadowRoot) return;

    activeItems = [];
    const rangesByColor: Record<string, Range[]> = {};

    if (matcherNeedsRebuild || !cachedMatcher) {
      cachedMatcher = new DOMTextMatcher();
      matcherNeedsRebuild = false;
    }
    const matcher = cachedMatcher;

    const CHUNK_SIZE = 20;
    let index = 0;

    function processChunk() {
      const end = Math.min(index + CHUNK_SIZE, annotations.length);
      for (let i = index; i < end; i++) {
        const item = annotations[i];
        const selector = item.target?.selector || item.selector;
        if (!selector?.exact) continue;

        const range = matcher.findRange(selector.exact);
        if (range) {
          activeItems.push({ range, item });

          const isHighlight = (item as any).type === 'Highlight';
          const defaultColor = isHighlight ? '#f59e0b' : '#3b82f6';
          const color = item.color || defaultColor;
          if (!rangesByColor[color]) rangesByColor[color] = [];
          rangesByColor[color].push(range);
        }
      }
      index = end;

      if (index < annotations.length) {
        if ('requestIdleCallback' in window) {
          requestIdleCallback(processChunk, { timeout: 500 });
        } else {
          setTimeout(processChunk, 0);
        }
      } else {
        commitHighlights();
      }
    }

    function commitHighlights() {
      if (typeof CSS !== 'undefined' && CSS.highlights) {
        clearOwnHighlights();
        for (const [color, ranges] of Object.entries(rangesByColor)) {
          const highlight = new Highlight(...ranges);
          const safeColor = color.replace(/[^a-zA-Z0-9]/g, '');
          const name = `margin-hl-${safeColor}`;
          setHighlight(name, highlight);
          injectHighlightStyle(name, color);
        }
      }
    }

    processChunk();
  }

  function injectHighlightStyle(name: string, color: string) {
    if (injectedStyles.has(name)) return;
    const style = document.createElement('style');

    const hex = color.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16) || 99;
    const g = parseInt(hex.substring(2, 4), 16) || 102;
    const b = parseInt(hex.substring(4, 6), 16) || 241;

    if (isPdfContext()) {
      style.textContent = `
            ::highlight(${name}) {
              background-color: rgba(${r}, ${g}, ${b}, 0.35);
              cursor: pointer;
            }
          `;
    } else {
      style.textContent = `
            ::highlight(${name}) {
              text-decoration: underline;
              text-decoration-color: ${color};
              text-decoration-thickness: 2px;
              text-underline-offset: 2px;
              cursor: pointer;
            }
          `;
    }

    document.head.appendChild(style);
    injectedStyles.add(name);
  }

  let hoverRafId: number | null = null;
  let hoverIntentTimer: ReturnType<typeof setTimeout> | null = null;

  function handleMouseMove(e: MouseEvent) {
    if (!overlayEnabled || !overlayHost) return;

    if (hoverRafId !== null) {
      cancelAnimationFrame(hoverRafId);
      hoverRafId = null;
    }

    hoverRafId = requestAnimationFrame(() => {
      hoverRafId = null;
      processHover(e.clientX, e.clientY, e);
    });
  }
  function getAnnotationsAtPoint(
    x: number,
    y: number
  ): Array<{ range: Range; item: Annotation; rect: DOMRect }> {
    const results: Array<{ range: Range; item: Annotation; rect: DOMRect }> = [];

    const pad = 6;
    for (const { range, item } of activeItems) {
      const rects = range.getClientRects();
      for (const rect of rects) {
        if (
          x >= rect.left - pad &&
          x <= rect.right + pad &&
          y >= rect.top - pad &&
          y <= rect.bottom + pad
        ) {
          if (!results.some((r) => r.item === item)) {
            results.push({ range, item, rect });
          }
          break;
        }
      }
    }

    return results;
  }

  function processHover(x: number, y: number, e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (
      target.closest(
        'a[href], button, input, select, textarea, [role="button"], [role="link"], [contenteditable]'
      )
    ) {
      document.body.style.cursor = '';
      if (hoverIndicator && !popoverEl) hoverIndicator.classList.remove('visible');
      return;
    }

    const foundItems = getAnnotationsAtPoint(x, y);
    const firstRange = foundItems[0]?.range ?? null;

    if (foundItems.length > 0 && shadowRoot) {
      document.body.style.cursor = 'pointer';

      if (!hoverIndicator) {
        const container = shadowRoot.getElementById('margin-overlay-container');
        if (container) {
          hoverIndicator = document.createElement('div');
          hoverIndicator.className = 'margin-hover-indicator';
          container.appendChild(hoverIndicator);
        }
      }

      if (hoverIndicator && firstRange) {
        const authorsMap = new Map<string, any>();
        foundItems.forEach(({ item }) => {
          const author = item.author || item.creator || {};
          const id = author.did || author.handle || 'unknown';
          if (!authorsMap.has(id)) {
            authorsMap.set(id, author);
          }
        });

        const uniqueAuthors = Array.from(authorsMap.values());
        const maxShow = 3;
        const displayAuthors = uniqueAuthors.slice(0, maxShow);
        const overflow = uniqueAuthors.length - maxShow;

        let html = displayAuthors
          .map((author, i) => {
            const avatar = author.avatar;
            const handle = author.handle || 'U';
            const marginLeft = i === 0 ? '0' : '-8px';

            if (avatar) {
              return `<img src="${escapeHtml(avatar)}" style="width: 24px; height: 24px; border-radius: 50%; object-fit: cover; border: 2px solid #09090b; margin-left: ${marginLeft};">`;
            } else {
              return `<div style="width: 24px; height: 24px; border-radius: 50%; background: #3b82f6; color: white; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; font-family: -apple-system, sans-serif; border: 2px solid #09090b; margin-left: ${marginLeft};">${escapeHtml(handle[0]?.toUpperCase() || 'U')}</div>`;
            }
          })
          .join('');

        if (overflow > 0) {
          html += `<div style="width: 24px; height: 24px; border-radius: 50%; background: #27272a; color: #a1a1aa; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; font-family: -apple-system, sans-serif; border: 2px solid #09090b; margin-left: -8px;">+${overflow}</div>`;
        }

        hoverIndicator.innerHTML = html;

        const firstRect = firstRange.getClientRects()[0];
        const totalWidth =
          Math.min(uniqueAuthors.length, maxShow + (overflow > 0 ? 1 : 0)) * 18 + 8;
        const indicatorHeight = 28;
        const gap = 4;

        let leftPos = firstRect.left - totalWidth;
        leftPos = Math.max(gap, Math.min(leftPos, window.innerWidth - totalWidth - gap));

        const topPos = Math.max(
          gap,
          Math.min(
            firstRect.top + firstRect.height / 2 - indicatorHeight / 2,
            window.innerHeight - indicatorHeight - gap
          )
        );

        hoverIndicator.style.left = `${leftPos}px`;
        hoverIndicator.style.top = `${topPos}px`;
        hoverIndicator.classList.add('visible');
      }
    } else {
      document.body.style.cursor = '';
      if (hoverIndicator && hoverIndicator.classList.contains('visible') && !popoverEl) {
        if (hoverIntentTimer) clearTimeout(hoverIntentTimer);
        hoverIntentTimer = setTimeout(() => {
          hoverIntentTimer = null;
          if (hoverIndicator && !popoverEl) hoverIndicator.classList.remove('visible');
        }, 120);
      }
    }
  }

  function handleDocumentClick(e: MouseEvent) {
    if (!overlayEnabled || !overlayHost) return;

    const x = e.clientX;
    const y = e.clientY;

    if (popoverEl) {
      const rect = popoverEl.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return;
      }
    }

    if (composeModal) {
      const rect = composeModal.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return;
      }
      composeModal.remove();
      composeModal = null;
    }

    const clickedItems: Annotation[] = getAnnotationsAtPoint(x, y).map((r) => r.item);

    if (clickedItems.length > 0) {
      const target = e.target as HTMLElement;
      if (
        target.closest(
          'a[href], button, input, select, textarea, [role="button"], [role="link"], [contenteditable]'
        )
      )
        return;

      e.preventDefault();
      e.stopPropagation();

      if (popoverEl) {
        const currentIds = popoverEl.dataset.itemIds;
        const newIds = clickedItems
          .map((i) => i.uri || i.id)
          .sort()
          .join(',');
        if (currentIds === newIds) {
          popoverEl.remove();
          popoverEl = null;
          return;
        }
      }

      const firstItem = clickedItems[0];
      const match = activeItems.find((x) => x.item === firstItem);
      if (match) {
        const rects = match.range.getClientRects();
        if (rects.length > 0) {
          const rect = rects[0];
          const top = rect.top + window.scrollY;
          const left = rect.left + window.scrollX;
          showPopover(clickedItems, top, left);
        }
      }
    } else {
      if (popoverEl) {
        popoverEl.remove();
        popoverEl = null;
      }
    }
  }

  function showPopover(items: Annotation[], top: number, left: number) {
    if (!shadowRoot) return;
    if (popoverEl) popoverEl.remove();

    const container = shadowRoot.getElementById('margin-overlay-container');
    if (!container) return;

    popoverEl = document.createElement('div');
    popoverEl.className = 'margin-popover';

    const ids = items
      .map((i) => i.uri || i.id)
      .sort()
      .join(',');
    popoverEl.dataset.itemIds = ids;

    const popWidth = 320;
    const screenWidth = window.innerWidth;
    let finalLeft = left;
    if (left + popWidth > screenWidth) finalLeft = screenWidth - popWidth - 20;
    if (finalLeft < 10) finalLeft = 10;

    popoverEl.style.top = `${top + 24}px`;
    popoverEl.style.left = `${finalLeft}px`;

    const count = items.length;
    const title = count === 1 ? 'Annotation' : `Annotations`;

    const contentHtml = items
      .map((item) => {
        const author = item.author || item.creator || {};
        const handle = author.handle || 'User';
        const avatar = author.avatar;
        const text = item.body?.value || item.text || '';
        const id = item.id || item.uri;
        const isHighlight = (item as any).type === 'Highlight';
        const isOwned = currentUserDid && author.did === currentUserDid;
        const createdAt = item.createdAt ? formatRelativeTime(item.createdAt) : '';

        let avatarHtml = `<div class="comment-avatar">${escapeHtml(handle[0]?.toUpperCase() || 'U')}</div>`;
        if (avatar) {
          avatarHtml = `<img src="${escapeHtml(avatar)}" class="comment-avatar" style="object-fit: cover;">`;
        }

        let bodyHtml = '';
        if (isHighlight && !text) {
          bodyHtml = `<div class="highlight-badge">${Icons.highlightMarker} Highlighted</div>`;
        } else {
          bodyHtml = `<div class="comment-text">${escapeHtml(text)}</div>`;
        }

        const safeId = escapeHtml(id || '');
        const addNoteBtn =
          isHighlight && isOwned
            ? `<button class="comment-action-btn btn-add-note" data-id="${safeId}" data-uri="${safeId}">${Icons.message} Annotate</button>`
            : '';

        return `
            <div class="comment-item" data-item-id="${safeId}">
              <div class="comment-header">
                ${avatarHtml}
                <div class="comment-meta">
                  <a class="comment-handle" href="${APP_URL}/profile/${escapeHtml(author.did || '')}" target="_blank" rel="noopener">@${escapeHtml(handle)}</a>
                  ${createdAt ? `<span class="comment-time">${escapeHtml(createdAt)}</span>` : ''}
                </div>
              </div>
              ${bodyHtml}
              <div class="comment-actions">
                ${addNoteBtn}
                ${!isHighlight ? `<button class="comment-action-btn btn-reply" data-id="${safeId}">${Icons.reply} Reply</button>` : ''}
                <button class="comment-action-btn btn-share" data-id="${safeId}" data-text="${escapeHtml(text)}">${Icons.share} Share</button>
              </div>
            </div>
          `;
      })
      .join('');

    popoverEl.innerHTML = `
        <div class="popover-header">
          <span class="popover-title">${title} <span class="popover-count">${count}</span></span>
          <button class="popover-close">${Icons.close}</button>
        </div>
        <div class="popover-scroll-area">
          ${contentHtml}
        </div>
      `;

    popoverEl.querySelector('.popover-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      popoverEl?.remove();
      popoverEl = null;
    });

    popoverEl.querySelectorAll('.btn-add-note').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const uri = (btn as HTMLElement).getAttribute('data-uri') || '';
        const itemId = (btn as HTMLElement).getAttribute('data-id') || '';
        const commentItem = btn.closest('.comment-item');
        if (!commentItem) return;

        if (commentItem.querySelector('.add-note-form')) return;

        const form = document.createElement('div');
        form.className = 'add-note-form';
        form.innerHTML = `
            <textarea class="add-note-textarea" placeholder="Add your note..." rows="3"></textarea>
            <div class="add-note-actions">
              <button class="add-note-cancel">${Icons.close}</button>
              <button class="add-note-submit">${Icons.send}</button>
            </div>
          `;

        commentItem.appendChild(form);
        const textarea = form.querySelector('textarea') as HTMLTextAreaElement;
        textarea?.focus();

        textarea?.addEventListener('keydown', (ke) => {
          if (ke.key === 'Enter' && !ke.shiftKey) {
            ke.preventDefault();
            submitNote();
          }
          if (ke.key === 'Escape') {
            form.remove();
          }
        });

        form.querySelector('.add-note-cancel')?.addEventListener('click', (ce) => {
          ce.stopPropagation();
          form.remove();
        });

        form.querySelector('.add-note-submit')?.addEventListener('click', (se) => {
          se.stopPropagation();
          submitNote();
        });

        async function submitNote() {
          const noteText = textarea?.value.trim();
          if (!noteText) return;

          const submitBtn = form.querySelector('.add-note-submit') as HTMLButtonElement;
          if (submitBtn) submitBtn.disabled = true;
          textarea.disabled = true;

          try {
            const matchingItem = items.find((i) => (i.id || i.uri) === itemId);
            const selector = matchingItem?.target?.selector || matchingItem?.selector;

            const result = await sendMessage('convertHighlightToAnnotation', {
              highlightUri: uri,
              url: getPageUrl(),
              title: document.title,
              text: noteText,
              selector: selector ? { type: 'TextQuoteSelector', exact: selector.exact } : undefined,
            });

            if (result.success) {
              showToast('Highlight converted to annotation!', 'success');
              popoverEl?.remove();
              popoverEl = null;
              cachedMatcher = null;
              setTimeout(() => fetchAnnotations(), 500);
            } else {
              showToast('Failed to convert', 'error');
              if (submitBtn) submitBtn.disabled = false;
              textarea.disabled = false;
            }
          } catch {
            showToast('Failed to convert', 'error');
            if (submitBtn) submitBtn.disabled = false;
            textarea.disabled = false;
          }
        }
      });
    });

    popoverEl.querySelectorAll('.btn-reply').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = (btn as HTMLElement).getAttribute('data-id');
        if (id) {
          window.open(`${APP_URL}/annotation/${encodeURIComponent(id)}`, '_blank');
        }
      });
    });

    popoverEl.querySelectorAll('.btn-share').forEach((btn) => {
      btn.addEventListener('click', async (_e) => {
        const id = (btn as HTMLElement).getAttribute('data-id') || '';
        const url = `${APP_URL}/annotation/${encodeURIComponent(id)}`;
        try {
          await navigator.clipboard.writeText(url);
          const originalInner = btn.innerHTML;
          btn.innerHTML = `${Icons.check} Copied!`;
          setTimeout(() => {
            btn.innerHTML = originalInner;
          }, 2000);
        } catch (error) {
          console.error('Failed to copy', error);
        }
      });
    });

    container.appendChild(popoverEl);
  }

  let lastPolledUrl = getPageUrl();

  function onUrlChange() {
    const currentUrl = getPageUrl();
    if (currentUrl === lastPolledUrl) return;
    lastPolledUrl = currentUrl;
    clearOwnHighlights();
    injectedStyles.clear();
    document.querySelectorAll('style').forEach((s) => {
      if (s.textContent?.includes('::highlight(margin-hl-')) s.remove();
    });
    activeItems = [];
    cachedMatcher = null;
    sendMessage('updateBadge', { count: 0 });
    if (overlayEnabled) {
      setTimeout(() => fetchAnnotations(), 300);
    }
  }

  window.addEventListener('popstate', onUrlChange);
  window.addEventListener('hashchange', onUrlChange);

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    onUrlChange();
  };

  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    onUrlChange();
  };

  let domChangeTimeout: ReturnType<typeof setTimeout> | null = null;
  let domChangeCount = 0;

  function isMeaningfulMutation(mutations: MutationRecord[]): boolean {
    for (const m of mutations) {
      if (m.type !== 'childList') continue;
      for (const node of [...m.addedNodes, ...m.removedNodes]) {
        if ((node as Element).id === 'margin-overlay-host') continue;
        if (node.nodeType === Node.TEXT_NODE && (node.textContent?.trim().length ?? 0) > 20)
          return true;
        if (node.nodeType === Node.ELEMENT_NODE) {
          const tag = (node as Element).tagName;
          if (['STYLE', 'SCRIPT', 'SVG', 'IMG', 'VIDEO', 'CANVAS'].includes(tag)) continue;
          if ((node as Element).textContent?.trim().length ?? 0 > 20) return true;
        }
      }
    }
    return false;
  }

  const observer = new MutationObserver((mutations) => {
    if (!overlayEnabled || !isMeaningfulMutation(mutations)) return;
    domChangeCount++;
    if (domChangeTimeout) clearTimeout(domChangeTimeout);
    const delay = Math.min(800 + domChangeCount * 200, 3000);
    domChangeTimeout = setTimeout(() => {
      matcherNeedsRebuild = true;
      domChangeCount = 0;
      fetchAnnotations();
    }, delay);
  });
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  if (document.querySelector('.pdfViewer') || /\.pdf(\?|#|$)/i.test(window.location.href)) {
    const pdfObserver = new MutationObserver(() => {
      const textLayers = document.querySelectorAll('.textLayer span');
      if (textLayers.length > 10) {
        if (domChangeTimeout) clearTimeout(domChangeTimeout);
        domChangeTimeout = setTimeout(() => {
          cachedMatcher = null;
          fetchAnnotations();
        }, 1000);
      }
    });
    pdfObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });

    ctx.onInvalidated(() => {
      pdfObserver.disconnect();
    });
  }

  ctx.onInvalidated(() => {
    observer.disconnect();
  });

  window.addEventListener('load', () => {
    setTimeout(() => fetchAnnotations(), 500);
  });
}
