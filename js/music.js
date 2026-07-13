class MusicPlayer {
  constructor() {
    this.storageKey = 'solitude-music-source';
    this.playerTimeout = 20000;
    this.host = document.getElementById('Music-page');
    this.switchElement = document.getElementById('Music-source-switch');
    this.statusElement = document.getElementById('Music-source-status');
    this.loadingElement = document.querySelector('.Music-loading');
    this.backgroundElement = document.getElementById('Music-bg');
    this.sourceButtons = [];
    this.timerIds = new Set();
    this.pendingWait = null;
    this.backgroundImage = null;
    this.aplayer = null;
    this.playerReady = false;
    this.lyricElement = null;
    this.destroyed = false;
    this.generation = 0;

    this.handleKeydown = this.handleKeydown.bind(this);
    this.handleSourceClick = this.handleSourceClick.bind(this);
    this.handleLyricsClick = this.handleLyricsClick.bind(this);
    this.handleLoadedData = this.handleLoadedData.bind(this);
    this.handleTimeUpdate = this.lrcUpdate.bind(this);
    this.handlePjaxSend = this.destroy.bind(this);

    this.init();
  }

  init() {
    if (!this.host) return;

    window.pauseCapsuleMusic?.();
    document.documentElement.style.setProperty('--vh', `${window.innerHeight}px`);
    this.initialMeting = this.getMetingElement();
    this.playerAttributes = this.getPlayerAttributes(this.initialMeting);
    this.config = this.getMusicConfig(this.initialMeting);
    this.sourceButtons = Array.from(document.querySelectorAll('#Music-source-switch [data-music-source]'));
    this.currentSource = this.findElementSource(this.initialMeting) || this.config.defaultSource;

    document.addEventListener('keydown', this.handleKeydown);
    window.addEventListener('pjax:send', this.handlePjaxSend, { once: true });
    this.sourceButtons.forEach(button => button.addEventListener('click', this.handleSourceClick));

    const savedSource = this.getSavedSource();
    const initialSource = savedSource || this.config.defaultSource;
    this.loadSource(initialSource, {
      existingElement: this.findElementSource(this.initialMeting) === initialSource ? this.initialMeting : null,
      previousSource: this.currentSource,
      isInitial: true
    });
  }

  getMusicConfig(initialMeting) {
    const globalConfig = window.SOLITUDE_MUSIC_CONFIG || {};
    const sources = {};

    Object.entries(globalConfig.sources || {}).forEach(([key, source]) => {
      if (!source || source.id == null || !source.server || !source.type) return;
      sources[key] = {
        label: source.label || key,
        server: String(source.server),
        type: String(source.type),
        id: String(source.id)
      };
    });

    if (!Object.keys(sources).length && initialMeting) {
      const key = globalConfig.defaultSource || initialMeting.getAttribute('server') || 'default';
      sources[key] = {
        label: initialMeting.getAttribute('server') || key,
        server: initialMeting.getAttribute('server'),
        type: initialMeting.getAttribute('type'),
        id: initialMeting.getAttribute('id')
      };
    }

    const sourceKeys = Object.keys(sources);
    const defaultSource = sources[globalConfig.defaultSource]
      ? globalConfig.defaultSource
      : sourceKeys[0];

    return { defaultSource, sources };
  }

  getPlayerAttributes(meting) {
    if (!meting) return {};
    return Array.from(meting.attributes).reduce((attributes, attribute) => {
      attributes[attribute.name] = attribute.value;
      return attributes;
    }, {});
  }

  getSavedSource() {
    try {
      const source = window.localStorage.getItem(this.storageKey);
      return this.config.sources[source] ? source : null;
    } catch (error) {
      return null;
    }
  }

  saveSource(source) {
    try {
      window.localStorage.setItem(this.storageKey, source);
    } catch (error) {
      // Storage can be unavailable in private browsing; playback should still work.
    }
  }

  findElementSource(meting) {
    if (!meting) return null;
    return Object.keys(this.config?.sources || {}).find(key => {
      const source = this.config.sources[key];
      return meting.getAttribute('server') === source.server
        && meting.getAttribute('type') === source.type
        && meting.getAttribute('id') === source.id;
    }) || null;
  }

  getSourceLabel(source) {
    return this.config.sources[source]?.label || source;
  }

  getMetingElement() {
    return this.host?.querySelector(':scope > meting-js') || null;
  }

  getPageAPlayer() {
    return this.getMetingElement()?.aplayer || this.aplayer;
  }

  handleSourceClick(event) {
    const source = event.currentTarget.dataset.musicSource;
    if (!this.config.sources[source] || this.pendingWait) return;
    if (source === this.currentSource && this.playerReady) return;
    this.loadSource(source, { previousSource: this.currentSource });
  }

  async loadSource(source, options = {}) {
    if (this.destroyed || !this.config.sources[source]) return;

    const previousSource = options.previousSource;
    const generation = ++this.generation;
    this.cancelPendingWait();
    this.setLoadingState(source);

    try {
      const meting = options.existingElement || this.replaceMetingElement(source);
      const aplayer = await this.waitForAPlayer(meting, generation);
      if (this.destroyed || generation !== this.generation) return;

      this.activatePlayer(aplayer);
      this.commitSource(source, { persist: !options.isInitial });
    } catch (error) {
      if (this.destroyed || generation !== this.generation || error.name === 'AbortError') return;

      console.error(`[Music] Failed to load ${source}:`, error);
      if (previousSource && previousSource !== source && this.config.sources[previousSource]) {
        await this.restoreSource(previousSource, source, generation);
      } else {
        this.showLoadFailure(source, error);
      }
    }
  }

  async restoreSource(previousSource, failedSource, generation) {
    try {
      const meting = this.replaceMetingElement(previousSource);
      const aplayer = await this.waitForAPlayer(meting, generation);
      if (this.destroyed || generation !== this.generation) return;

      this.activatePlayer(aplayer);
      this.currentSource = previousSource;
      this.saveSource(previousSource);
      this.setActiveState(previousSource);
      this.setStatus(
        `${this.getSourceLabel(failedSource)}加载失败，已恢复${this.getSourceLabel(previousSource)}`,
        'error'
      );
      this.markSourceError(failedSource);
      this.dispatchSourceChange(previousSource);
    } catch (restoreError) {
      if (this.destroyed || generation !== this.generation || restoreError.name === 'AbortError') return;
      console.error(`[Music] Failed to restore ${previousSource}:`, restoreError);
      this.showLoadFailure(failedSource, restoreError, previousSource);
    }
  }

  replaceMetingElement(source) {
    const sourceConfig = this.config.sources[source];
    const oldMeting = this.getMetingElement();
    this.detachPlayerListeners();
    this.playerReady = false;
    this.retireMetingElement(oldMeting);

    const meting = document.createElement('meting-js');
    Object.entries(this.playerAttributes).forEach(([name, value]) => meting.setAttribute(name, value));
    meting.setAttribute('server', sourceConfig.server);
    meting.setAttribute('type', sourceConfig.type);
    meting.setAttribute('id', sourceConfig.id);
    this.host.replaceChildren(meting);
    this.resetPlayerVisuals();
    return meting;
  }

  waitForAPlayer(meting, generation) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        this.clearTrackedTimer(intervalId);
        this.clearTrackedTimer(timeoutId);
        if (this.pendingWait?.generation === generation) this.pendingWait = null;
        callback(value);
      };

      const checkPlayer = () => {
        if (this.destroyed || generation !== this.generation) {
          const abortError = new Error('Music player load was cancelled');
          abortError.name = 'AbortError';
          finish(reject, abortError);
          return;
        }

        if (!meting.isConnected) {
          finish(reject, new Error('Music player element was removed before initialization'));
          return;
        }

        if (meting.aplayer && typeof meting.aplayer.on === 'function') {
          finish(resolve, meting.aplayer);
        }
      };

      const intervalId = this.setTrackedInterval(checkPlayer, 100);
      const timeoutId = this.setTrackedTimeout(() => {
        finish(reject, new Error(`Music source did not initialize within ${this.playerTimeout / 1000} seconds`));
      }, this.playerTimeout);

      this.pendingWait = {
        generation,
        cancel: () => {
          const abortError = new Error('Music player load was cancelled');
          abortError.name = 'AbortError';
          finish(reject, abortError);
        }
      };
      checkPlayer();
    });
  }

  activatePlayer(aplayer) {
    this.aplayer = aplayer;
    this.playerReady = true;
    aplayer.pause();
    aplayer.on('loadeddata', this.handleLoadedData);
    aplayer.on('timeupdate', this.handleTimeUpdate);

    this.lyricElement = this.host.querySelector('.aplayer-lrc');
    this.lyricElement?.addEventListener('click', this.handleLyricsClick);
    this.setLoadingVisible(false);

    if (this.backgroundElement) {
      this.backgroundElement.style.display = 'block';
      this.updateBackgroundImage(this.backgroundElement);
    }
  }

  commitSource(source, { persist = true } = {}) {
    this.currentSource = source;
    if (persist) this.saveSource(source);
    this.setActiveState(source);
    this.setStatus(`当前音源：${this.getSourceLabel(source)}`, 'ready');
    this.dispatchSourceChange(source);
  }

  dispatchSourceChange(source) {
    window.dispatchEvent(new CustomEvent('solitude:music-source-change', {
      detail: { source }
    }));
  }

  setLoadingState(source) {
    const label = this.getSourceLabel(source);
    this.switchElement?.setAttribute('aria-busy', 'true');
    this.sourceButtons.forEach(button => {
      const isLoading = button.dataset.musicSource === source;
      button.disabled = true;
      button.classList.toggle('is-loading', isLoading);
      button.classList.remove('is-error');
      button.removeAttribute('aria-invalid');
    });
    this.setStatus(`正在加载${label}…`, 'loading');
    this.setLoadingVisible(true);
  }

  setActiveState(source) {
    this.switchElement?.removeAttribute('aria-busy');
    this.sourceButtons.forEach(button => {
      const isActive = button.dataset.musicSource === source;
      button.disabled = false;
      button.classList.remove('is-loading', 'is-error');
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
      button.removeAttribute('aria-invalid');
    });
  }

  markSourceError(source) {
    const button = this.sourceButtons.find(item => item.dataset.musicSource === source);
    button?.classList.add('is-error');
    button?.setAttribute('aria-invalid', 'true');
  }

  showLoadFailure(source, error, restoreSource) {
    const failedMeting = this.getMetingElement();
    this.playerReady = false;
    this.retireMetingElement(failedMeting);
    this.switchElement?.removeAttribute('aria-busy');
    this.sourceButtons.forEach(button => {
      button.disabled = false;
      button.classList.remove('is-loading', 'is-active');
      button.setAttribute('aria-pressed', 'false');
    });
    this.markSourceError(source);
    const restoreMessage = restoreSource ? `，${this.getSourceLabel(restoreSource)}也无法恢复` : '，请稍后重试';
    this.setStatus(`${this.getSourceLabel(source)}加载失败${restoreMessage}`, 'error');
    this.setLoadingVisible(false);
    this.resetPlayerVisuals();
  }

  setStatus(message, state) {
    if (!this.statusElement) return;
    this.statusElement.textContent = message;
    this.statusElement.classList.toggle('is-loading', state === 'loading');
    this.statusElement.classList.toggle('is-error', state === 'error');
  }

  setLoadingVisible(visible) {
    if (this.loadingElement) this.loadingElement.style.display = visible ? 'flex' : 'none';
  }

  resetPlayerVisuals() {
    if (!this.backgroundElement) return;
    this.backgroundElement.classList.remove('show');
    this.backgroundElement.style.display = 'none';
    this.backgroundElement.style.backgroundImage = '';
  }

  handleLoadedData() {
    this.updateBackgroundImage(this.backgroundElement);
  }

  updateBackgroundImage(element) {
    const musicCover = this.host?.querySelector('.aplayer-pic');
    if (!element || !musicCover) return;

    const backgroundImage = musicCover.style.backgroundImage || window.getComputedStyle(musicCover).backgroundImage;
    const source = this.extractValue(backgroundImage);
    if (!source) return;

    if (this.backgroundImage) {
      this.backgroundImage.onload = null;
      this.backgroundImage.onerror = null;
    }

    const image = new Image();
    this.backgroundImage = image;
    image.src = source;
    image.onload = () => {
      if (this.destroyed || image !== this.backgroundImage) return;
      element.style.backgroundImage = backgroundImage;
      element.classList.add('show');
      this.backgroundImage = null;
    };
    image.onerror = () => {
      if (image === this.backgroundImage) this.backgroundImage = null;
    };
  }

  extractValue(input) {
    const match = /^url\((['"]?)(.*?)\1\)$/.exec(input || '');
    return match ? match[2] : '';
  }

  handleLyricsClick() {
    this.host?.querySelector('.aplayer-list')?.classList.toggle('aplayer-list-hide');
  }

  lrcUpdate() {
    const contents = this.host?.querySelector('.aplayer-lrc-contents');
    const currentLrc = contents?.querySelector('p.aplayer-lrc-current');
    if (!contents || !currentLrc) return;

    const currentIndex = Array.from(contents.children).indexOf(currentLrc);
    contents.style.transform = `translateY(${-currentIndex * 80}px)`;
  }

  handleKeydown(event) {
    const target = event.target;
    if (target instanceof HTMLElement
      && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName))) return;

    const aplayer = this.getPageAPlayer();
    if (!aplayer) return;

    const actions = {
      Space: () => aplayer.toggle(),
      ArrowRight: () => aplayer.skipForward(),
      ArrowLeft: () => aplayer.skipBack(),
      ArrowUp: () => aplayer.volume(Math.min(1, (aplayer.audio?.volume || 0) + 0.1)),
      ArrowDown: () => aplayer.volume(Math.max(0, (aplayer.audio?.volume || 0) - 0.1))
    };

    if (!actions[event.code]) return;
    event.preventDefault();
    actions[event.code]();
  }

  detachPlayerListeners() {
    this.lyricElement?.removeEventListener('click', this.handleLyricsClick);
    this.lyricElement = null;
    this.aplayer = null;
  }

  destroyAPlayer(aplayer) {
    if (!aplayer) return;
    try {
      aplayer.pause();
      // APlayer keeps a private two-second skip timer after audio errors.
      // Triggering listswitch clears it before the detached list is destroyed.
      aplayer.events?.trigger('listswitch', { index: aplayer.list?.index });
      if (aplayer.noticeTime) window.clearTimeout(aplayer.noticeTime);
      if (aplayer.events?.events) aplayer.events.events = {};
      aplayer.destroy();
    } catch (error) {
      console.warn('[Music] Failed to destroy the previous APlayer instance:', error);
    }
  }

  retireMetingElement(meting) {
    if (!meting) return;
    // MetingJS 2.0.1 assumes APlayer exists on detach and can finish a stale fetch later.
    meting.lock = true;
    meting._loadPlayer = () => {};
    this.destroyAPlayer(meting.aplayer);
    meting.remove();
  }

  setTrackedTimeout(callback, delay) {
    const timerId = window.setTimeout(() => {
      this.timerIds.delete(timerId);
      callback();
    }, delay);
    this.timerIds.add(timerId);
    return timerId;
  }

  setTrackedInterval(callback, delay) {
    const timerId = window.setInterval(callback, delay);
    this.timerIds.add(timerId);
    return timerId;
  }

  clearTrackedTimer(timerId) {
    window.clearTimeout(timerId);
    window.clearInterval(timerId);
    this.timerIds.delete(timerId);
  }

  cancelPendingWait() {
    const pendingWait = this.pendingWait;
    this.pendingWait = null;
    pendingWait?.cancel();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation += 1;
    this.cancelPendingWait();
    document.removeEventListener('keydown', this.handleKeydown);
    window.removeEventListener('pjax:send', this.handlePjaxSend);
    this.sourceButtons.forEach(button => button.removeEventListener('click', this.handleSourceClick));
    this.detachPlayerListeners();
    this.playerReady = false;
    const meting = this.getMetingElement();
    if (meting) {
      meting.lock = true;
      meting._loadPlayer = () => {};
      if (meting.isConnected) this.destroyAPlayer(meting.aplayer);
    }
    this.timerIds.forEach(timerId => this.clearTrackedTimer(timerId));
    this.timerIds.clear();

    if (this.backgroundImage) {
      this.backgroundImage.onload = null;
      this.backgroundImage.onerror = null;
      this.backgroundImage = null;
    }
  }
}

function initializeMusicPlayer() {
  const existingMusic = window.scoMusic;
  const currentHost = document.getElementById('Music-page');
  if (existingMusic?.host === currentHost && !existingMusic.destroyed) return;
  if (existingMusic) existingMusic.destroy();
  window.scoMusic = new MusicPlayer();
}
