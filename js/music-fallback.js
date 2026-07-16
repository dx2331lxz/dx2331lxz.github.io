(() => {
  if (window.utils?.attachMusicFallback) return;

  const fallbackRequests = new Map();
  const sourceLabels = {
    netease: '网易云',
    daoliyu: '道理鱼',
    comparison: '网易云和道理鱼'
  };

  const releaseTrackBlobUrl = track => {
    const blobUrl = track?._solitudeFallbackBlobUrl || track?.blobUrl;
    if (!blobUrl || !String(blobUrl).startsWith('blob:')) return;
    try { URL.revokeObjectURL(blobUrl); } catch (error) {}
    if (track?._solitudeFallbackBlobUrl === blobUrl) track._solitudeFallbackBlobUrl = null;
  };

  const cancelMusicFallbackOperation = aplayer => {
    const operation = aplayer?._solitudeFallbackOperation;
    if (!operation) return false;
    operation.cancelled = true;
    operation.track._solitudeFallbackPending = false;
    try { operation.controller.abort(); } catch (error) {}
    if (aplayer._solitudeFallbackOperation === operation) {
      aplayer._solitudeFallbackOperation = null;
    }
    return true;
  };

  const releaseMusicFallbackUrls = aplayer => {
    cancelMusicFallbackOperation(aplayer);
    aplayer?.list?.audios?.forEach(releaseTrackBlobUrl);
  };

  const getTrackTitle = track => String(track?.title || track?.name || '').trim();
  const getTrackAuthor = track => String(track?.author || track?.artist || '').trim();
  const normalizeText = value => String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
  const getArtistTokens = value => String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .split(/[,，&、/;；]|\s+(?:feat\.?|ft\.?)\s+/i)
    .map(normalizeText)
    .filter(Boolean);

  const uniqueBy = (items, getKey) => {
    const keys = new Set();
    return items.filter(item => {
      const key = getKey(item);
      if (!key || keys.has(key)) return false;
      keys.add(key);
      return true;
    });
  };

  const getDaoliyuQueries = track => {
    const title = getTrackTitle(track);
    const artist = getTrackAuthor(track);
    const simplifiedTitle = title
      .replace(/\s*[\[(（【][^\])）】]*[\])）】]\s*/g, ' ')
      .replace(/\s+(?:feat\.?|ft\.?)\s+.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const artistParts = artist
      .normalize('NFKC')
      .split(/[,，&、/;；]|\s+(?:feat\.?|ft\.?)\s+/i)
      .map(value => value.trim())
      .filter(Boolean);
    const titleVariants = uniqueBy([title, simplifiedTitle], normalizeText);
    const artistVariants = uniqueBy([artist, ...artistParts], normalizeText);

    return uniqueBy(
      titleVariants.flatMap(titleVariant => artistVariants.map(artistVariant => ({
        title: titleVariant,
        artist: artistVariant
      }))),
      query => `${normalizeText(query.title)}:${normalizeText(query.artist)}`
    ).slice(0, 6);
  };

  const isSameTrack = (sourceTrack, candidate) => {
    if (normalizeText(getTrackTitle(sourceTrack)) !== normalizeText(getTrackTitle(candidate))) return false;

    const sourceArtists = getArtistTokens(getTrackAuthor(sourceTrack));
    const candidateArtists = getArtistTokens(getTrackAuthor(candidate));
    return sourceArtists.some(sourceArtist => candidateArtists.some(candidateArtist => (
      sourceArtist === candidateArtist
      || (sourceArtist.length >= 4 && candidateArtist.length >= 4
        && (sourceArtist.includes(candidateArtist) || candidateArtist.includes(sourceArtist)))
    )));
  };

  const replaceApiToken = (input, token, value) => input.split(token).join(encodeURIComponent(value ?? ''));
  const buildApiUrl = (api, source) => {
    let requestUrl = String(api);
    requestUrl = replaceApiToken(requestUrl, ':server', source.server);
    requestUrl = replaceApiToken(requestUrl, ':type', source.type);
    requestUrl = replaceApiToken(requestUrl, ':id', source.id);
    requestUrl = replaceApiToken(requestUrl, ':auth', source.auth || '');
    return replaceApiToken(requestUrl, ':r', Math.random());
  };

  const getCacheKey = (track, fallbackSource) => [
    'solitude-music-fallback-v3',
    fallbackSource.server,
    normalizeText(getTrackTitle(track)),
    getArtistTokens(getTrackAuthor(track)).sort().join('-')
  ].join(':');

  const readCache = cacheKey => {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey));
      if (!cached || Date.now() >= cached.expiresAt) {
        if (cached) localStorage.removeItem(cacheKey);
        return { hit: false, track: null };
      }
      return { hit: true, track: cached.track || null };
    } catch (error) {
      try { localStorage.removeItem(cacheKey); } catch (storageError) {}
      return { hit: false, track: null };
    }
  };

  const writeCache = (cacheKey, track, ttl) => {
    try {
      localStorage.setItem(cacheKey, JSON.stringify({
        expiresAt: Date.now() + ttl,
        track: track ? {
          title: getTrackTitle(track),
          author: getTrackAuthor(track),
          url: track.url,
          pic: track.pic || track.cover || '',
          lrc: track.lrc || '',
          source: track.source || '',
          duration: Number(track.duration) || null,
          expires: Number(track.expires) || null
        } : null
      }));
    } catch (error) {}
  };

  const createAbortScope = (parentSignal, timeout) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener('abort', abort, { once: true });
    const timeoutId = window.setTimeout(abort, timeout);
    return {
      signal: controller.signal,
      cleanup: () => {
        window.clearTimeout(timeoutId);
        parentSignal?.removeEventListener('abort', abort);
      }
    };
  };

  const inspectAudio = (url, previewMaxDuration, signal) => {
    if (!url || typeof window.Audio !== 'function') {
      return Promise.resolve({ playable: false, duration: null, preview: false });
    }
    if (signal?.aborted) {
      return Promise.resolve({ playable: false, duration: null, preview: false, cancelled: true });
    }

    return new Promise(resolve => {
      const audio = new window.Audio();
      let settled = false;

      const finish = result => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        audio.removeEventListener('loadedmetadata', handleMetadata);
        audio.removeEventListener('durationchange', handleMetadata);
        audio.removeEventListener('error', handleError);
        signal?.removeEventListener('abort', handleAbort);
        audio.pause();
        audio.removeAttribute('src');
        try { audio.load(); } catch (error) {}
        resolve(result);
      };

      const handleMetadata = () => {
        const duration = Number(audio.duration);
        if (!Number.isFinite(duration) || duration <= 0) return;
        finish({
          playable: true,
          duration,
          preview: previewMaxDuration > 0 && duration <= previewMaxDuration
        });
      };
      const handleError = () => finish({ playable: false, duration: null, preview: false });
      const handleAbort = () => finish({ playable: false, duration: null, preview: false, cancelled: true });
      const timeoutId = window.setTimeout(handleError, 12000);

      audio.preload = 'metadata';
      audio.addEventListener('loadedmetadata', handleMetadata);
      audio.addEventListener('durationchange', handleMetadata);
      audio.addEventListener('error', handleError);
      signal?.addEventListener('abort', handleAbort, { once: true });
      audio.src = url;
      audio.load();
    });
  };

  const resolveNeteaseTrack = async (api, track, fallbackSource, options) => {
    const query = [getTrackTitle(track), getTrackAuthor(track)].filter(Boolean).join(' ');
    const searchSource = { ...fallbackSource, type: 'search', id: query };
    const abortScope = createAbortScope(options.signal, 12000);

    try {
      const response = await fetch(buildApiUrl(api, searchSource), {
        signal: abortScope.signal,
        credentials: 'omit'
      });
      if (!response.ok) throw new Error(`Music fallback API returned HTTP ${response.status}`);

      const candidates = await response.json();
      if (!Array.isArray(candidates)) return { track: null, reason: 'unavailable' };

      const matches = candidates.filter(candidate => isSameTrack(track, candidate)).slice(0, 5);
      const inspections = await Promise.all(matches.map(candidate => (
        inspectAudio(candidate.url, options.previewMaxDuration, abortScope.signal)
      )));
      const resolvedIndex = inspections.findIndex(inspection => inspection.playable && !inspection.preview);
      if (resolvedIndex !== -1) {
        return {
          track: {
            ...matches[resolvedIndex],
            source: fallbackSource.server,
            duration: inspections[resolvedIndex].duration
          },
          reason: 'resolved'
        };
      }
      const previewDetected = inspections.some(inspection => inspection.playable && inspection.preview);
      return { track: null, reason: previewDetected ? 'preview' : 'unavailable' };
    } catch (error) {
      if (error?.name !== 'AbortError') console.warn('[Music] NetEase fallback lookup failed:', error);
      const cancelled = options.signal?.aborted === true;
      return { track: null, reason: cancelled ? 'cancelled' : 'error', cancelled, transient: true };
    } finally {
      abortScope.cleanup();
    }
  };

  const lookupDaoliyuTrack = async (track, options) => {
    const config = options.daoliyu || {};
    if (config.enable !== true || !config.api) return { track: null, reason: 'disabled' };

    const abortScope = createAbortScope(options.signal, 15000);
    try {
      let result = null;
      for (const query of getDaoliyuQueries(track)) {
        const resolveUrl = new URL('/resolve', String(config.api).replace(/\/?$/, '/'));
        resolveUrl.searchParams.set('title', query.title);
        resolveUrl.searchParams.set('artist', query.artist);

        const response = await fetch(resolveUrl, {
          signal: abortScope.signal,
          credentials: 'omit',
          cache: 'no-store'
        });
        if (response.status === 404) continue;
        if (!response.ok) throw new Error(`Daoliyu fallback API returned HTTP ${response.status}`);

        const candidate = await response.json();
        if (candidate?.url) {
          result = candidate;
          break;
        }
      }
      if (!result) return { track: null, reason: 'unavailable' };
      return {
        track: {
          title: result.title || getTrackTitle(track),
          author: result.artist || getTrackAuthor(track),
          url: result.url,
          source: 'daoliyu',
          duration: Number(result.duration) || null,
          expires: Number(result.expires) || null
        },
        reason: 'resolved'
      };
    } catch (error) {
      if (error?.name !== 'AbortError') console.warn('[Music] Daoliyu fallback lookup failed:', error);
      const cancelled = options.signal?.aborted === true;
      return { track: null, reason: cancelled ? 'cancelled' : 'error', cancelled, transient: true };
    } finally {
      abortScope.cleanup();
    }
  };

  const loadDaoliyuTrack = async (lookupResult, options) => {
    const track = lookupResult?.track;
    if (!track?.url) return { track: null, reason: lookupResult?.reason || 'unavailable' };

    const abortScope = createAbortScope(options.signal, 45000);
    let blobUrl = null;
    try {
      const response = await fetch(track.url, {
        signal: abortScope.signal,
        credentials: 'omit',
        cache: 'no-store'
      });
      if (!response.ok) throw new Error(`Daoliyu stream returned HTTP ${response.status}`);

      const audioBlob = await response.blob();
      if (!audioBlob.size) throw new Error('Daoliyu stream returned an empty audio file');
      blobUrl = typeof URL.createObjectURL === 'function'
        ? URL.createObjectURL(audioBlob)
        : track.url;
      return {
        track: {
          ...track,
          url: blobUrl,
          blobUrl: blobUrl.startsWith('blob:') ? blobUrl : null
        },
        reason: 'resolved'
      };
    } catch (error) {
      if (blobUrl?.startsWith('blob:')) {
        try { URL.revokeObjectURL(blobUrl); } catch (revokeError) {}
      }
      if (error?.name !== 'AbortError') console.warn('[Music] Daoliyu stream loading failed:', error);
      const cancelled = options.signal?.aborted === true;
      return { track: null, reason: cancelled ? 'cancelled' : 'error', cancelled, transient: true };
    } finally {
      abortScope.cleanup();
    }
  };

  const selectMoreCompleteSource = (neteaseTrack, daoliyuTrack) => {
    if (!neteaseTrack) return daoliyuTrack ? 'daoliyu' : null;
    if (!daoliyuTrack) return 'netease';

    const neteaseDuration = Number(neteaseTrack.duration);
    const daoliyuDuration = Number(daoliyuTrack.duration);
    const hasNeteaseDuration = Number.isFinite(neteaseDuration) && neteaseDuration > 0;
    const hasDaoliyuDuration = Number.isFinite(daoliyuDuration) && daoliyuDuration > 0;
    if (hasNeteaseDuration && hasDaoliyuDuration) {
      return daoliyuDuration > neteaseDuration ? 'daoliyu' : 'netease';
    }
    if (hasDaoliyuDuration) return 'daoliyu';
    return 'netease';
  };

  const getMusicFallbackTrack = (api, track, fallbackSource, options = {}) => {
    if (!api || !track || !fallbackSource?.server) return Promise.resolve(null);

    const cacheKey = getCacheKey(track, fallbackSource);
    const cached = readCache(cacheKey);
    const skipNetease = options.skipNetease === true;
    const daoliyuEnabled = options.daoliyu?.enable === true && Boolean(options.daoliyu.api);
    const canUseCachedTrack = cached.track
      && !(skipNetease && cached.track.source === fallbackSource.server);
    if (!daoliyuEnabled && cached.hit && canUseCachedTrack) {
      return Promise.resolve(cached.track);
    }
    // DaoLiYu's index can change at any time. Never let an old negative lookup
    // prevent a fresh Worker request for a track that may now be available.
    if (cached.hit && !cached.track && !daoliyuEnabled) return Promise.resolve(null);

    const requestKey = [
      cacheKey,
      skipNetease ? 'daoliyu' : 'all',
      options.requestId || 'shared'
    ].join(':');
    const existingRequest = fallbackRequests.get(requestKey);
    if (existingRequest) return existingRequest;

    const positiveTtl = Number(options.positiveTtl) > 0 ? Number(options.positiveTtl) : 604800000;
    const negativeTtl = Number(options.negativeTtl) > 0 ? Number(options.negativeTtl) : 86400000;
    const request = (async () => {
      let transientFailure = false;
      const neteasePromise = skipNetease
        ? Promise.resolve({ track: null, reason: 'skipped' })
        : canUseCachedTrack
          ? Promise.resolve({ track: cached.track, reason: 'cached' })
          : resolveNeteaseTrack(api, track, fallbackSource, options);
      const daoliyuPromise = daoliyuEnabled
        ? lookupDaoliyuTrack(track, options)
        : Promise.resolve({ track: null, reason: 'disabled' });
      const [neteaseResult, daoliyuResult] = await Promise.all([neteasePromise, daoliyuPromise]);
      if (options.signal?.aborted) return null;

      transientFailure ||= neteaseResult.transient === true || daoliyuResult.transient === true;
      if (neteaseResult.track && neteaseResult.reason !== 'cached') {
        writeCache(cacheKey, neteaseResult.track, positiveTtl);
      }

      const selectedSource = selectMoreCompleteSource(neteaseResult.track, daoliyuResult.track);
      if (selectedSource === 'netease') return neteaseResult.track;
      if (selectedSource === 'daoliyu') {
        options.onProgress?.({ source: 'daoliyu', reason: 'more-complete' });
        const loadedDaoliyu = await loadDaoliyuTrack(daoliyuResult, options);
        if (options.signal?.aborted) {
          releaseTrackBlobUrl(loadedDaoliyu.track);
          return null;
        }
        transientFailure ||= loadedDaoliyu.transient === true;
        if (loadedDaoliyu.track) {
          // Blob URLs are scoped to the current document and cannot be persisted.
          return loadedDaoliyu.track;
        }
        if (neteaseResult.track) return neteaseResult.track;
      }

      if (!transientFailure && !daoliyuEnabled) writeCache(cacheKey, null, negativeTtl);
      return null;
    })().finally(() => fallbackRequests.delete(requestKey));

    fallbackRequests.set(requestKey, request);
    return request;
  };

  const attachMusicFallback = (aplayer, config = {}) => {
    const activeSource = config.activeSource;
    const fallbackSource = config.fallbackSource;
    if (!aplayer?.on || aplayer._solitudeFallbackAttached
      || activeSource?.server !== 'tencent' || fallbackSource?.server !== 'netease') return false;

    aplayer._solitudeFallbackAttached = true;
    const isActive = () => typeof config.isActive !== 'function' || config.isActive(aplayer);
    const notify = (state, detail = {}) => {
      try {
        config.onStatus?.({ state, activeSource, fallbackSource, ...detail });
      } catch (error) {
        console.warn('[Music] Fallback status handler failed:', error);
      }
    };
    const finishOperation = operation => {
      operation.track._solitudeFallbackPending = false;
      if (aplayer._solitudeFallbackOperation === operation) {
        aplayer._solitudeFallbackOperation = null;
      }
    };

    aplayer.on('listswitch', detail => {
      const operation = aplayer._solitudeFallbackOperation;
      const nextIndex = Number(detail?.index);
      if (!operation || !Number.isInteger(nextIndex) || nextIndex === operation.index) return;

      operation.cancelled = true;
      try { operation.controller.abort(); } catch (error) {}
      finishOperation(operation);
      aplayer.notice?.('已取消上一首的音源匹配', 1200);
      notify('cancelled', { track: operation.track, index: operation.index, nextIndex });

      window.setTimeout(() => {
        if (!operation.shouldResume || !isActive() || aplayer.list?.index !== nextIndex) return;
        aplayer.play();
      }, 0);
    });

    aplayer.on('error', () => {
      if (!isActive()) return;

      const index = aplayer.list?.index;
      const track = aplayer.list?.audios?.[index];
      if (!track) return;

      const currentFallback = track._solitudeFallbackSource;
      const daoliyuExpired = currentFallback === 'daoliyu'
        && Number(track._solitudeFallbackExpires) * 1000 <= Date.now() + 5000;
      if (currentFallback === 'daoliyu' && !daoliyuExpired) {
        aplayer.notice?.('道理鱼音源暂时无法播放，将自动跳过', 2500);
        notify('fallback-error', { track, index, resolvedSource: 'daoliyu' });
        return;
      }
      const failedUntil = Number(track._solitudeFallbackFailedUntil) || 0;
      if (track._solitudeFallbackFailed && failedUntil > Date.now()) {
        aplayer.notice?.('暂无可用的完整替代音源，将自动跳过', 2500);
        return;
      }
      track._solitudeFallbackFailed = false;
      track._solitudeFallbackFailedUntil = null;

      // Cancel APlayer's built-in two-second skip while the replacement is resolved.
      aplayer.events?.trigger('listswitch', { index });
      if (track._solitudeFallbackPending) return;

      const skipNetease = currentFallback === fallbackSource.server || daoliyuExpired;
      const shouldResume = !aplayer.paused;
      track._solitudeFallbackPending = true;
      aplayer.pause();
      const operation = {
        id: `${Date.now()}-${Math.random()}`,
        controller: new AbortController(),
        track,
        index,
        shouldResume,
        cancelled: false
      };
      aplayer._solitudeFallbackOperation = operation;
      const initialTarget = skipNetease ? 'daoliyu' : 'comparison';
      aplayer.notice?.(`正在匹配${sourceLabels[initialTarget]}完整音源…`, 0);
      notify('resolving', { track, index, targetSource: initialTarget });

      getMusicFallbackTrack(config.api, track, fallbackSource, {
        ...config,
        skipNetease,
        signal: operation.controller.signal,
        requestId: operation.id,
        onProgress: ({ source, reason }) => {
          if (operation.cancelled) return;
          if (!isActive() || aplayer.list?.audios?.[index] !== track) return;
          aplayer.notice?.(`正在匹配${sourceLabels[source] || source}完整音源…`, 0);
          notify('resolving', { track, index, targetSource: source, reason });
        }
      })
        .then(fallbackTrack => {
          if (operation.cancelled) {
            releaseTrackBlobUrl(fallbackTrack);
            return;
          }
          finishOperation(operation);
          if (!isActive()) {
            releaseTrackBlobUrl(fallbackTrack);
            return;
          }

          const isCurrentTrack = aplayer.list?.index === index && aplayer.list?.audios?.[index] === track;
          if (!fallbackTrack) {
            track._solitudeFallbackFailed = true;
            track._solitudeFallbackFailedUntil = Date.now() + 60000;
            if (!isCurrentTrack) return;

            aplayer.notice?.('暂无可用的完整替代音源，已跳过', 2500);
            notify('failed', { track, index });
            if (aplayer.list.audios.length > 1) {
              aplayer.skipForward();
              if (shouldResume) aplayer.play();
            }
            return;
          }
          if (!isCurrentTrack) {
            releaseTrackBlobUrl(fallbackTrack);
            return;
          }

          releaseTrackBlobUrl(track);
          track._solitudeOriginalUrl ||= track.url;
          track._solitudeFallbackSource = fallbackTrack.source || fallbackSource.server;
          track._solitudeFallbackExpires = fallbackTrack.expires || null;
          track._solitudeFallbackBlobUrl = fallbackTrack.blobUrl || null;
          track._solitudeFallbackFailed = false;
          track._solitudeFallbackFailedUntil = null;
          track.url = fallbackTrack.url;
          if (!track.cover && (fallbackTrack.pic || fallbackTrack.cover)) {
            track.cover = fallbackTrack.pic || fallbackTrack.cover;
          }
          if (!track.lrc && fallbackTrack.lrc) track.lrc = fallbackTrack.lrc;

          aplayer.list.switch(index);
          if (shouldResume) aplayer.play();
          const resolvedSource = track._solitudeFallbackSource;
          const label = sourceLabels[resolvedSource] || resolvedSource;
          aplayer.notice?.(`已切换至${label}完整音源`, 3000);
          notify('resolved', { track, fallbackTrack, index, resolvedSource });
        })
        .catch(error => {
          finishOperation(operation);
          if (operation.cancelled) return;
          console.warn('[Music] Failed to apply fallback track:', error);
        });
    });
    return true;
  };

  window.utils = {
    ...window.utils,
    attachMusicFallback,
    getMusicFallbackTrack,
    releaseMusicFallbackUrls
  };
})();
