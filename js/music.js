class MusicPlayer {
  constructor() {
    this.storageKey = 'solitude-music-source';
    this.playerTimeout = 15000;
    this.host = document.getElementById('Music-page');
    this.sourcePanel = document.getElementById('Music-source-panel');
    this.switchElement = document.getElementById('Music-source-switch');
    this.statusElement = document.getElementById('Music-source-status');
    this.helpElement = document.getElementById('Music-source-help');
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
    this.handlePanelClick = this.handlePanelClick.bind(this);
    this.handleLyricsClick = this.handleLyricsClick.bind(this);
    this.handleLoadedData = this.handleLoadedData.bind(this);
    this.handleTimeUpdate = this.lrcUpdate.bind(this);
    this.handlePjaxSend = this.destroy.bind(this);
    this.handleViewportResize = this.updateViewportHeight.bind(this);

    this.init();
  }

  init() {
    if (!this.host) return;

    window.pauseCapsuleMusic?.();
    this.updateViewportHeight();
    this.config = this.getMusicConfig();
    this.playerAttributes = this.getPlayerAttributes(this.config.player);
    this.sourceButtons = Array.from(document.querySelectorAll('#Music-source-switch [data-music-source]'));
    this.currentSource = this.config.defaultSource;

    document.addEventListener('keydown', this.handleKeydown);
    window.addEventListener('pjax:send', this.handlePjaxSend, { once: true });
    window.addEventListener('resize', this.handleViewportResize, { passive: true });
    window.visualViewport?.addEventListener('resize', this.handleViewportResize, { passive: true });
    this.sourcePanel?.addEventListener('click', this.handlePanelClick);
    this.sourceButtons.forEach(button => button.addEventListener('click', this.handleSourceClick));

    const savedSource = this.getSavedSource();
    const initialSource = savedSource || this.config.initialSource || this.config.defaultSource;
    this.loadSource(initialSource, {
      previousSource: this.currentSource,
      isInitial: true
    });
  }

  getMusicConfig() {
    const globalConfig = window.SOLITUDE_MUSIC_CONFIG || {};
    const sources = {};

    Object.entries(globalConfig.sources || {}).forEach(([key, source]) => {
      if (!source || source.id == null || !source.server || !source.type) return;
      sources[key] = {
        ...source,
        label: source.label || key,
        server: String(source.server),
        type: String(source.type),
        id: String(source.id)
      };
    });

    const sourceKeys = Object.keys(sources);
    const defaultSource = sources[globalConfig.defaultSource]
      ? globalConfig.defaultSource
      : sourceKeys[0];
    const fallbackConfig = globalConfig.fallback || {};
    const fallbackSource = sources[fallbackConfig.source]
      ? fallbackConfig.source
      : sourceKeys.find(key => sources[key].server === 'netease');
    const daoliyuConfig = fallbackConfig.daoliyu || {};

    return {
      api: globalConfig.api || window.meting_api,
      cacheTtl: Number(globalConfig.cacheTtl) || 600000,
      defaultSource,
      initialSource: sources[globalConfig.initialSource] ? globalConfig.initialSource : defaultSource,
      player: globalConfig.player || {},
      sources,
      reverse: globalConfig.reverse === true,
      fallback: {
        enable: fallbackConfig.enable === true && Boolean(fallbackSource),
        source: fallbackSource,
        positiveTtl: Number(fallbackConfig.positiveTtl || fallbackConfig.positive_ttl) || 604800000,
        negativeTtl: Number(fallbackConfig.negativeTtl || fallbackConfig.negative_ttl) || 86400000,
        previewMaxDuration: Number(fallbackConfig.previewMaxDuration || fallbackConfig.preview_max_duration) || 35,
        daoliyu: {
          enable: daoliyuConfig.enable === true && Boolean(daoliyuConfig.api),
          api: String(daoliyuConfig.api || '')
        }
      }
    };
  }

  getPlayerAttributes(playerConfig) {
    return Object.entries(playerConfig || {}).reduce((attributes, [name, value]) => {
      if (value == null) return attributes;
      attributes[name] = String(value);
      return attributes;
    }, {});
  }

  updateViewportHeight() {
    const height = window.visualViewport?.height || window.innerHeight;
    document.documentElement.style.setProperty('--vh', `${height}px`);
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

  handlePanelClick(event) {
    event.stopPropagation();
  }

  async loadSource(source, options = {}) {
    if (this.destroyed || !this.config.sources[source]) return;

    const previousSource = options.previousSource;
    const generation = ++this.generation;
    let replacedPlayer = false;
    this.cancelPendingWait();
    this.setLoadingState(source);
    this.getPageAPlayer()?.pause();

    try {
      const playlist = await this.getPlaylist(source);
      if (this.destroyed || generation !== this.generation) return;

      const meting = this.replaceMetingElement(source, playlist);
      replacedPlayer = true;
      const loadedPlayer = await this.waitForAPlayer(meting, generation);
      if (this.destroyed || generation !== this.generation) return;

      const aplayer = this.ensurePlaylistOrder(meting, loadedPlayer);
      this.activatePlayer(aplayer);
      this.commitSource(source, { persist: !options.isInitial });
    } catch (error) {
      if (this.destroyed || generation !== this.generation) return;

      console.error(`[Music] Failed to load ${source}:`, error);
      const currentMeting = this.getMetingElement();
      const canKeepPreviousPlayer = !replacedPlayer
        && previousSource
        && this.findElementSource(currentMeting) === previousSource
        && currentMeting?.aplayer;

      if (canKeepPreviousPlayer) {
        this.playerReady = true;
        this.currentSource = previousSource;
        this.setActiveState(previousSource);
        this.updateSourceHelp(previousSource);
        this.setStatus(
          `${this.getSourceLabel(source)}加载失败，已保留${this.getSourceLabel(previousSource)}`,
          'error'
        );
        this.markSourceError(source);
        this.setLoadingVisible(false);
        return;
      }

      if (previousSource && previousSource !== source && this.config.sources[previousSource]) {
        await this.restoreSource(previousSource, source, generation);
      } else {
        this.showLoadFailure(source, error);
      }
    }
  }

  async restoreSource(previousSource, failedSource, generation) {
    try {
      const playlist = await this.getPlaylist(previousSource);
      if (this.destroyed || generation !== this.generation) return;

      const meting = this.replaceMetingElement(previousSource, playlist);
      const loadedPlayer = await this.waitForAPlayer(meting, generation);
      if (this.destroyed || generation !== this.generation) return;

      const aplayer = this.ensurePlaylistOrder(meting, loadedPlayer);
      this.activatePlayer(aplayer);
      this.currentSource = previousSource;
      this.saveSource(previousSource);
      this.setActiveState(previousSource);
      this.updateSourceHelp(previousSource);
      this.setStatus(
        `${this.getSourceLabel(failedSource)}加载失败，已恢复${this.getSourceLabel(previousSource)}`,
        'error'
      );
      this.markSourceError(failedSource);
      this.dispatchSourceChange(previousSource);
    } catch (restoreError) {
      if (this.destroyed || generation !== this.generation) return;
      console.error(`[Music] Failed to restore ${previousSource}:`, restoreError);
      this.showLoadFailure(failedSource, restoreError, previousSource);
    }
  }

  getPlaylist(source) {
    const sourceConfig = this.config.sources[source];
    if (!sourceConfig || typeof window.utils?.getMusicPlaylist !== 'function') {
      return Promise.reject(new Error('Music playlist loader is unavailable'));
    }
    return window.utils.getMusicPlaylist(this.config.api, sourceConfig, this.config.cacheTtl);
  }

  replaceMetingElement(source, playlist) {
    const sourceConfig = this.config.sources[source];
    const oldMeting = this.getMetingElement();
    this.detachPlayerListeners();
    this.playerReady = false;
    this.parkSourcePanel();
    this.retireMetingElement(oldMeting);

    const meting = document.createElement('meting-js');
    Object.entries(this.playerAttributes).forEach(([name, value]) => meting.setAttribute(name, value));
    meting.setAttribute('server', sourceConfig.server);
    meting.setAttribute('type', sourceConfig.type);
    meting.setAttribute('id', sourceConfig.id);
    meting.dataset.musicSource = source;
    this.configurePlaylistLoader(meting, sourceConfig, playlist);
    this.configurePlaylistOrder(meting);
    this.host.replaceChildren(meting);
    this.resetPlayerVisuals();
    return meting;
  }

  configurePlaylistLoader(meting, sourceConfig, prefetchedPlaylist) {
    if (!meting) return;

    meting._parse = () => {
      const request = Array.isArray(prefetchedPlaylist)
        ? Promise.resolve(prefetchedPlaylist.map(track => ({ ...track })))
        : window.utils.getMusicPlaylist(this.config.api, sourceConfig, this.config.cacheTtl);

      meting._solitudePlaylistError = null;
      meting._solitudePlaylistPromise = request;
      return request
        .then(playlist => {
          if (!meting.isConnected || meting.lock) return;
          meting._loadPlayer(playlist);
        })
        .catch(error => {
          meting._solitudePlaylistError = error;
          console.error('[Music] Playlist request failed:', error);
        });
    };
  }

  configurePlaylistOrder(meting) {
    if (!this.config.reverse || !meting || meting._solitudeReverseConfigured || typeof meting._loadPlayer !== 'function') return;

    meting._solitudeReverseConfigured = true;
    const loadPlayer = meting._loadPlayer.bind(meting);
    meting._loadPlayer = audios => {
      const orderedAudios = Array.isArray(audios) ? [...audios].reverse() : audios;
      meting._solitudeReverseApplied = true;
      loadPlayer(orderedAudios);
    };
  }

  ensurePlaylistOrder(meting, aplayer) {
    if (!this.config.reverse || meting?._solitudeReverseApplied) return aplayer;

    const audios = aplayer?.list?.audios;
    if (!Array.isArray(audios) || audios.length < 2 || typeof window.APlayer !== 'function') {
      if (meting) meting._solitudeReverseApplied = true;
      return aplayer;
    }

    const options = {
      ...aplayer.options,
      container: aplayer.container,
      audio: [...audios].reverse(),
      autoplay: false
    };

    this.destroyAPlayer(aplayer);
    const orderedPlayer = new window.APlayer(options);
    meting.aplayer = orderedPlayer;
    meting._solitudeReverseApplied = true;
    return orderedPlayer;
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

        if (meting._solitudePlaylistError) {
          finish(reject, meting._solitudePlaylistError);
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
    this.attachMusicFallback(aplayer);

    this.lyricElement = this.host.querySelector('.aplayer-lrc');
    this.lyricElement?.addEventListener('click', this.handleLyricsClick);
    this.mountSourcePanel();
    this.setLoadingVisible(false);

    if (this.backgroundElement) {
      this.backgroundElement.style.display = 'block';
      this.updateBackgroundImage(this.backgroundElement);
    }
  }

  attachMusicFallback(aplayer) {
    const fallback = this.config.fallback;
    const activeSourceKey = this.findElementSource(this.getMetingElement());
    const activeSource = this.config.sources[activeSourceKey];
    const fallbackSource = this.config.sources[fallback.source];
    if (!fallback.enable || typeof window.utils?.attachMusicFallback !== 'function') return;

    window.utils.attachMusicFallback(aplayer, {
      api: this.config.api,
      activeSource,
      fallbackSource,
      positiveTtl: fallback.positiveTtl,
      negativeTtl: fallback.negativeTtl,
      previewMaxDuration: fallback.previewMaxDuration,
      daoliyu: fallback.daoliyu,
      isActive: player => !this.destroyed && this.getPageAPlayer() === player,
      onStatus: detail => this.handleFallbackStatus(detail)
    });
  }

  handleFallbackStatus({ state, track, targetSource, resolvedSource }) {
    if (this.destroyed) return;
    const title = track?.name || track?.title || '当前歌曲';
    const sourceLabels = { netease: '网易云', daoliyu: '道理鱼' };

    if (state === 'resolving') {
      const label = sourceLabels[targetSource] || '替代';
      this.setStatus(`《${title}》正在匹配${label}完整音源…`, 'loading');
      return;
    }

    if (state === 'resolved') {
      const label = sourceLabels[resolvedSource] || '替代';
      this.setStatus(`《${title}》已切换至${label}完整音源`, 'ready');
      window.utils?.snackbarShow?.(`《${title}》已切换至${label}完整音源`, false, 3000);
      return;
    }

    const message = state === 'fallback-error'
      ? `《${title}》的${sourceLabels[resolvedSource] || '替代'}音源无法播放，已自动跳过`
      : `《${title}》暂无可用的完整替代音源，已自动跳过`;
    this.setStatus(message, 'error');
    window.utils?.snackbarShow?.(message, false, 3500);
    this.setTrackedTimeout(() => {
      if (this.destroyed) return;
      const currentSource = this.currentSource;
      this.setStatus(`当前音源：${this.getSourceLabel(currentSource)}`, 'ready');
    }, 4000);
  }

  commitSource(source, { persist = true } = {}) {
    this.currentSource = source;
    if (persist) this.saveSource(source);
    this.setActiveState(source);
    this.updateSourceHelp(source);
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
    this.updateSourceHelp(source);
    this.sourceButtons.forEach(button => {
      const isLoading = button.dataset.musicSource === source;
      button.disabled = true;
      button.classList.toggle('is-loading', isLoading);
      button.classList.remove('is-error');
      button.removeAttribute('aria-invalid');
    });
    this.setStatus(`正在加载${label}…`, 'loading');
    this.setLoadingVisible(!this.playerReady);
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
    this.showFallbackPanel();
    this.setLoadingVisible(false);
    this.resetPlayerVisuals();
  }

  setStatus(message, state) {
    if (!this.statusElement) return;
    this.statusElement.textContent = message;
    this.statusElement.classList.toggle('is-loading', state === 'loading');
    this.statusElement.classList.toggle('is-error', state === 'error');
    this.statusElement.classList.toggle('is-ready', state === 'ready');
    this.sourcePanel?.classList.toggle('is-loading', state === 'loading');
    this.sourcePanel?.classList.toggle('is-error', state === 'error');
    this.sourcePanel?.classList.toggle('is-ready', state === 'ready');
  }

  updateSourceHelp(source) {
    if (!this.helpElement) return;
    const showHelp = this.config.sources[source]?.server === 'tencent';
    this.helpElement.hidden = !showHelp;
    this.sourcePanel?.classList.toggle('has-help', showHelp);
  }

  parkSourcePanel() {
    if (!this.sourcePanel) return;
    this.sourcePanel.remove();
    this.sourcePanel.classList.add('is-staging');
  }

  mountSourcePanel() {
    const playlist = this.host?.querySelector('.aplayer-list');
    if (!playlist || !this.sourcePanel) return;
    this.sourcePanel.classList.remove('is-staging');
    playlist.prepend(this.sourcePanel);
  }

  showFallbackPanel() {
    if (!this.host || !this.sourcePanel) return;
    this.sourcePanel.classList.add('is-staging');
    this.host.before(this.sourcePanel);
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
      window.utils?.releaseMusicFallbackUrls?.(aplayer);
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
    if (this.sourcePanel && meting.contains(this.sourcePanel)) this.parkSourcePanel();
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
    window.removeEventListener('resize', this.handleViewportResize);
    window.visualViewport?.removeEventListener('resize', this.handleViewportResize);
    this.sourcePanel?.removeEventListener('click', this.handlePanelClick);
    this.sourceButtons.forEach(button => button.removeEventListener('click', this.handleSourceClick));
    this.detachPlayerListeners();
    this.playerReady = false;
    const meting = this.getMetingElement();
    if (meting) {
      if (this.sourcePanel && meting.contains(this.sourcePanel)) this.parkSourcePanel();
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
