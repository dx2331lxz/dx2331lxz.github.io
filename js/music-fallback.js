(() => {
  if (window.utils?.attachMusicFallback) return;

  const fallbackRequests = new Map();
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
    'solitude-music-fallback-v1',
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
          lrc: track.lrc || ''
        } : null
      }));
    } catch (error) {}
  };

  const validateUrl = url => {
    if (!url) return Promise.resolve(false);

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 10000);
    return fetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store'
    })
      .then(response => {
        const playable = response.ok;
        if (response.body) response.body.cancel().catch(() => {});
        return playable;
      })
      .catch(() => false)
      .finally(() => window.clearTimeout(timeoutId));
  };

  const getMusicFallbackTrack = (api, track, fallbackSource, options = {}) => {
    if (!api || !track || !fallbackSource?.server) return Promise.resolve(null);

    const cacheKey = getCacheKey(track, fallbackSource);
    const cached = readCache(cacheKey);
    if (cached.hit) return Promise.resolve(cached.track);

    const existingRequest = fallbackRequests.get(cacheKey);
    if (existingRequest) return existingRequest;

    const query = [getTrackTitle(track), getTrackAuthor(track)].filter(Boolean).join(' ');
    const searchSource = { ...fallbackSource, type: 'search', id: query };
    const positiveTtl = Number(options.positiveTtl) > 0 ? Number(options.positiveTtl) : 604800000;
    const negativeTtl = Number(options.negativeTtl) > 0 ? Number(options.negativeTtl) : 86400000;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 12000);
    const request = fetch(buildApiUrl(api, searchSource), {
      signal: controller.signal,
      credentials: 'omit'
    })
      .then(response => {
        if (!response.ok) throw new Error(`Music fallback API returned HTTP ${response.status}`);
        return response.json();
      })
      .then(candidates => {
        if (!Array.isArray(candidates)) return null;
        return candidates.find(candidate => isSameTrack(track, candidate)) || null;
      })
      .then(async candidate => {
        if (!candidate || !await validateUrl(candidate.url)) {
          writeCache(cacheKey, null, negativeTtl);
          return null;
        }
        writeCache(cacheKey, candidate, positiveTtl);
        return candidate;
      })
      .catch(error => {
        if (error?.name !== 'AbortError') console.warn('[Music] Fallback lookup failed:', error);
        return null;
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
        fallbackRequests.delete(cacheKey);
      });

    fallbackRequests.set(cacheKey, request);
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

      if (track._solitudeFallbackSource === fallbackSource.server) {
        aplayer.notice?.('网易云替代音源也无法播放，将自动跳过', 2500);
        notify('fallback-error', { track, index });
        return;
      }
      if (track._solitudeFallbackFailed) {
        aplayer.notice?.('暂无可用的网易云替代音源，将自动跳过', 2500);
        return;
      }

      // Cancel APlayer's built-in two-second skip while the replacement is resolved.
      aplayer.events?.trigger('listswitch', { index });
      if (track._solitudeFallbackPending) return;

      const shouldResume = !aplayer.paused;
      track._solitudeFallbackPending = true;
      aplayer.pause();
      aplayer.notice?.('QQ 音源不可用，正在匹配网易云…', 0);
      notify('resolving', { track, index });

      getMusicFallbackTrack(config.api, track, fallbackSource, config)
        .then(fallbackTrack => {
          track._solitudeFallbackPending = false;
          if (!isActive()) return;

          const isCurrentTrack = aplayer.list?.index === index && aplayer.list?.audios?.[index] === track;
          if (!fallbackTrack) {
            track._solitudeFallbackFailed = true;
            if (!isCurrentTrack) return;

            aplayer.notice?.('暂无可用的网易云替代音源，已跳过', 2500);
            notify('failed', { track, index });
            if (aplayer.list.audios.length > 1) {
              aplayer.skipForward();
              if (shouldResume) aplayer.play();
            }
            return;
          }

          track._solitudeOriginalUrl ||= track.url;
          track._solitudeFallbackSource = fallbackSource.server;
          track.url = fallbackTrack.url;
          if (!track.cover && (fallbackTrack.pic || fallbackTrack.cover)) {
            track.cover = fallbackTrack.pic || fallbackTrack.cover;
          }
          if (!track.lrc && fallbackTrack.lrc) track.lrc = fallbackTrack.lrc;
          if (!isCurrentTrack) return;

          aplayer.list.switch(index);
          if (shouldResume) aplayer.play();
          aplayer.notice?.('已切换至网易云音源', 3000);
          notify('resolved', { track, fallbackTrack, index });
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
    getMusicFallbackTrack
  };
})();
