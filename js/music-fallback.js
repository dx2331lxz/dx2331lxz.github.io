(() => {
  if (window.utils?.attachMusicFallback) return;

  const fallbackRequests = new Map();
  const sourceLabels = {
    netease: '网易云',
    daoliyu: '道理鱼'
  };

  const releaseTrackBlobUrl = track => {
    const blobUrl = track?._solitudeFallbackBlobUrl || track?.blobUrl;
    if (!blobUrl || !String(blobUrl).startsWith('blob:')) return;
    try { URL.revokeObjectURL(blobUrl); } catch (error) {}
    if (track?._solitudeFallbackBlobUrl === blobUrl) track._solitudeFallbackBlobUrl = null;
  };

  const releaseMusicFallbackUrls = aplayer => {
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

  const inspectAudio = (url, previewMaxDuration) => {
    if (!url || typeof window.Audio !== 'function') {
      return Promise.resolve({ playable: false, duration: null, preview: false });
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
      const timeoutId = window.setTimeout(handleError, 12000);

      audio.preload = 'metadata';
      audio.addEventListener('loadedmetadata', handleMetadata);
      audio.addEventListener('durationchange', handleMetadata);
      audio.addEventListener('error', handleError);
      audio.src = url;
      audio.load();
    });
  };

  const resolveNeteaseTrack = async (api, track, fallbackSource, options) => {
    const query = [getTrackTitle(track), getTrackAuthor(track)].filter(Boolean).join(' ');
    const searchSource = { ...fallbackSource, type: 'search', id: query };
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(buildApiUrl(api, searchSource), {
        signal: controller.signal,
        credentials: 'omit'
      });
      if (!response.ok) throw new Error(`Music fallback API returned HTTP ${response.status}`);

      const candidates = await response.json();
      if (!Array.isArray(candidates)) return { track: null, reason: 'unavailable' };

      const matches = candidates.filter(candidate => isSameTrack(track, candidate)).slice(0, 5);
      const inspections = await Promise.all(matches.map(candidate => (
        inspectAudio(candidate.url, options.previewMaxDuration)
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
      return { track: null, reason: 'error', transient: true };
    } finally {
      window.clearTimeout(timeoutId);
    }
  };

  const resolveDaoliyuTrack = async (track, options) => {
    const config = options.daoliyu || {};
    if (config.enable !== true || !config.api) return { track: null, reason: 'disabled' };

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 15000);
    let blobUrl = null;
    try {
      let result = null;
      for (const query of getDaoliyuQueries(track)) {
        const resolveUrl = new URL('/resolve', String(config.api).replace(/\/?$/, '/'));
        resolveUrl.searchParams.set('title', query.title);
        resolveUrl.searchParams.set('artist', query.artist);

        const response = await fetch(resolveUrl, {
          signal: controller.signal,
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
      window.clearTimeout(timeoutId);

      const streamController = new AbortController();
      const streamTimeoutId = window.setTimeout(() => streamController.abort(), 45000);
      let streamResponse;
      try {
        streamResponse = await fetch(result.url, {
          signal: streamController.signal,
          credentials: 'omit',
          cache: 'no-store'
        });
        if (!streamResponse.ok) {
          throw new Error(`Daoliyu stream returned HTTP ${streamResponse.status}`);
        }
        const audioBlob = await streamResponse.blob();
        if (!audioBlob.size) throw new Error('Daoliyu stream returned an empty audio file');
        blobUrl = typeof URL.createObjectURL === 'function'
          ? URL.createObjectURL(audioBlob)
          : result.url;
      } finally {
        window.clearTimeout(streamTimeoutId);
      }

      return {
        track: {
          title: result.title || getTrackTitle(track),
          author: result.artist || getTrackAuthor(track),
          url: blobUrl,
          blobUrl: blobUrl.startsWith('blob:') ? blobUrl : null,
          source: 'daoliyu',
          duration: Number(result.duration) || null,
          expires: Number(result.expires) || null
        },
        reason: 'resolved'
      };
    } catch (error) {
      if (blobUrl?.startsWith('blob:')) {
        try { URL.revokeObjectURL(blobUrl); } catch (revokeError) {}
      }
      if (error?.name !== 'AbortError') console.warn('[Music] Daoliyu fallback lookup failed:', error);
      return { track: null, reason: 'error', transient: true };
    } finally {
      window.clearTimeout(timeoutId);
    }
  };

  const getMusicFallbackTrack = (api, track, fallbackSource, options = {}) => {
    if (!api || !track || !fallbackSource?.server) return Promise.resolve(null);

    const cacheKey = getCacheKey(track, fallbackSource);
    const cached = readCache(cacheKey);
    const skipNetease = options.skipNetease === true;
    const daoliyuEnabled = options.daoliyu?.enable === true && Boolean(options.daoliyu.api);
    const canUseCachedTrack = cached.track
      && !(skipNetease && cached.track.source === fallbackSource.server);
    if (cached.hit && canUseCachedTrack) {
      return Promise.resolve(cached.track);
    }
    // DaoLiYu's index can change at any time. Never let an old negative lookup
    // prevent a fresh Worker request for a track that may now be available.
    if (cached.hit && !cached.track && !daoliyuEnabled) return Promise.resolve(null);

    const requestKey = `${cacheKey}:${skipNetease ? 'daoliyu' : 'all'}`;
    const existingRequest = fallbackRequests.get(requestKey);
    if (existingRequest) return existingRequest;

    const positiveTtl = Number(options.positiveTtl) > 0 ? Number(options.positiveTtl) : 604800000;
    const negativeTtl = Number(options.negativeTtl) > 0 ? Number(options.negativeTtl) : 86400000;
    const request = (async () => {
      let transientFailure = false;
      if (!skipNetease) {
        const neteaseResult = await resolveNeteaseTrack(api, track, fallbackSource, options);
        transientFailure ||= neteaseResult.transient === true;
        if (neteaseResult.track) {
          writeCache(cacheKey, neteaseResult.track, positiveTtl);
          return neteaseResult.track;
        }
        options.onProgress?.({ source: 'daoliyu', reason: neteaseResult.reason });
      }

      const daoliyuResult = await resolveDaoliyuTrack(track, options);
      transientFailure ||= daoliyuResult.transient === true;
      if (daoliyuResult.track) {
        // Blob URLs are scoped to the current document and cannot be persisted.
        return daoliyuResult.track;
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
      const initialTarget = skipNetease ? 'daoliyu' : fallbackSource.server;
      aplayer.notice?.(`正在匹配${sourceLabels[initialTarget]}完整音源…`, 0);
      notify('resolving', { track, index, targetSource: initialTarget });

      getMusicFallbackTrack(config.api, track, fallbackSource, {
        ...config,
        skipNetease,
        onProgress: ({ source, reason }) => {
          if (!isActive() || aplayer.list?.audios?.[index] !== track) return;
          aplayer.notice?.(`正在匹配${sourceLabels[source] || source}完整音源…`, 0);
          notify('resolving', { track, index, targetSource: source, reason });
        }
      })
        .then(fallbackTrack => {
          track._solitudeFallbackPending = false;
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
          track._solitudeFallbackPending = false;
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
