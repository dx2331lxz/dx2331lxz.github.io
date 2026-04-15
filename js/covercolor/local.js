const coverColor = () => {
    const pageColor = PAGE_CONFIG.color || document.getElementById("post-cover")?.src;
    if (pageColor) {
        return isHexColor(pageColor) ? setThemeColors(normalizeHex(pageColor)) : localColor(pageColor);
    }
    setDefaultThemeColors();
}

const setDefaultThemeColors = () => {
    const themeVars = {
        '--efu-main': 'var(--efu-theme)',
        '--efu-main-op': 'var(--efu-theme-op)',
        '--efu-main-op-deep': 'var(--efu-theme-op-deep)',
        '--efu-main-none': 'var(--efu-theme-none)'
    };
    Object.entries(themeVars).forEach(([key, value]) => {
        document.documentElement.style.setProperty(key, value);
    });
    initThemeColor();
}

const isHexColor = value => /^#?[\da-f]{6}$/i.test(value || '');

const normalizeHex = value => value.startsWith('#') ? value : `#${value}`;

const getCacheGroup = () => JSON.parse(localStorage.getItem('Solitude')) || { postcolor: {} };

const getCachedColor = src => {
    const cacheGroup = getCacheGroup();
    const cache = cacheGroup.postcolor?.[src];
    if (!cache) return null;

    if (cache.expiration && cache.expiration < Date.now()) {
        delete cacheGroup.postcolor[src];
        localStorage.setItem('Solitude', JSON.stringify(cacheGroup));
        return null;
    }

    return cache.value;
}

const cacheColor = (src, color) => {
    const cacheGroup = getCacheGroup();
    cacheGroup.postcolor = cacheGroup.postcolor || {};
    cacheGroup.postcolor[src] = { value: color, expiration: Date.now() + coverColorConfig.time };
    localStorage.setItem('Solitude', JSON.stringify(cacheGroup));
}

const localColor = path => {
    const cachedColor = getCachedColor(path);
    if (cachedColor) {
        setThemeColors(cachedColor);
        return;
    }

    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
        try {
            const [hexColor, r, g, b] = extractColorFromImage(img);
            cacheColor(path, hexColor);
            setThemeColors(hexColor, r, g, b);
        } catch (error) {
            console.error('Image color extraction failed:', error);
            setDefaultThemeColors();
        }
    };
    img.onerror = () => {
        console.error('Image Error');
        setDefaultThemeColors();
    };
    img.src = path;
}

const extractColorFromImage = img => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const maxSize = 64;
    const ratio = Math.min(maxSize / img.naturalWidth, maxSize / img.naturalHeight, 1);
    const width = Math.max(1, Math.round(img.naturalWidth * ratio));
    const height = Math.max(1, Math.round(img.naturalHeight * ratio));

    canvas.width = width;
    canvas.height = height;
    context.drawImage(img, 0, 0, width, height);

    const { data } = context.getImageData(0, 0, width, height);
    const buckets = new Map();
    const pixelStep = Math.max(1, Math.floor((width * height) / 400));

    for (let index = 0; index < data.length; index += pixelStep * 4) {
        const alpha = data[index + 3];
        if (alpha < 125) continue;

        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        const brightness = (r * 299 + g * 587 + b * 114) / 1000;

        if (brightness < 28 || brightness > 235) continue;

        const key = [r, g, b].map(value => Math.floor(value / 24)).join('-');
        const weight = 1 + Math.abs(128 - brightness) / 128;
        const bucket = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };

        bucket.count += weight;
        bucket.r += r * weight;
        bucket.g += g * weight;
        bucket.b += b * weight;
        buckets.set(key, bucket);
    }

    if (!buckets.size) {
        throw new Error('No valid pixels found');
    }

    const dominant = [...buckets.values()].sort((left, right) => right.count - left.count)[0];
    const rgb = [dominant.r, dominant.g, dominant.b].map(value => Math.round(value / dominant.count));
    return [rgbToHex(rgb), ...rgb];
}

const rgbToHex = ([r, g, b]) => {
    return '#' + [r, g, b].map(value => {
        const channel = Math.max(0, Math.min(255, Math.round(value * 0.85)));
        return channel.toString(16).padStart(2, '0');
    }).join('');
}

const setThemeColors = (value, r = null, g = null, b = null) => {
    if (!value) return setDefaultThemeColors();

    const themeColors = {
        '--efu-main': value,
        '--efu-main-op': value + '23',
        '--efu-main-op-deep': value + 'dd',
        '--efu-main-none': value + '00'
    };
    Object.entries(themeColors).forEach(([key, color]) => {
        document.documentElement.style.setProperty(key, color);
    });

    if (r !== null && g !== null && b !== null) {
        const brightness = Math.round(((parseInt(r) * 299) + (parseInt(g) * 587) + (parseInt(b) * 114)) / 1000);
        if (brightness < 125) {
            adjustCardStyles();
            value = LightenDarkenColor(value, 50);
            Object.entries({
                '--efu-main': value,
                '--efu-main-op': value + '23',
                '--efu-main-op-deep': value + 'dd',
                '--efu-main-none': value + '00'
            }).forEach(([key, color]) => {
                document.documentElement.style.setProperty(key, color);
            });
        }
    }

    document.getElementById("coverdiv").classList.add("loaded");
    initThemeColor();
}

function LightenDarkenColor(col, amt) {
    const hex = normalizeHex(col).slice(1);
    const next = [0, 2, 4].map(index => {
        const value = parseInt(hex.slice(index, index + 2), 16);
        return Math.max(0, Math.min(255, value + amt)).toString(16).padStart(2, '0');
    }).join('');
    return `#${next}`;
}

const adjustCardStyles = () => {
    const cardContents = document.getElementsByClassName('card-content');
    Array.from(cardContents).forEach(item => {
        item.style.setProperty('--efu-card-bg', 'var(--efu-white)');
    });

    const authorInfo = document.getElementsByClassName('author-info__sayhi');
    Array.from(authorInfo).forEach(item => {
        item.style.setProperty('background', 'var(--efu-white-op)');
        item.style.setProperty('color', 'var(--efu-white)');
    });
}
