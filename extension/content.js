(function () {
    console.log('[Spectral AI Imageye Extension] Active on page.');

    let selectedImages = new Map(); // url -> { url, title, thumbnail, score }

    const SPECTRAL_KEYWORDS = [
        'spectrum', 'spectra', 'absorbance', 'wavelength', 'transmittance',
        'reflectance', 'uv-vis', 'uv', 'ir', 'ftir', 'nm', 'extinction',
        'molar', 'peak', 'graph', 'chart', 'plot', 'intensity'
    ];

    // Inject Imageye floating toolbar
    const toolbar = document.createElement('div');
    toolbar.id = 'spectral-extension-toolbar';
    toolbar.innerHTML = `
        <div class="brand-title">
            <span>👁️ Imageye Spectral Extractor</span>
            <span class="badge-count" id="spectral-count-badge">0 selected</span>
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
            <button id="btn-imageye-auto" style="background: #8B5CF6; color: white; border: none; padding: 6px 12px; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 0.8rem;">⚡ Imageye Auto-Select Spectra</button>
            <button id="btn-send-to-spectral" disabled style="padding: 6px 12px; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 0.8rem;">🚀 Send to Spectral AI App</button>
        </div>
    `;
    document.body.appendChild(toolbar);

    const countBadge = document.getElementById('spectral-count-badge');
    const sendBtn = document.getElementById('btn-send-to-spectral');
    const autoBtn = document.getElementById('btn-imageye-auto');

    // Calculate Imageye Spectral Relevance Score (0 - 100)
    function scoreImageRelevance(img) {
        const parentLink = img.closest('a') || img.parentElement;
        const textContext = [
            img.alt || '',
            img.title || '',
            parentLink ? (parentLink.getAttribute('aria-label') || parentLink.innerText || '') : '',
            img.src || ''
        ].join(' ').toLowerCase();

        let hits = 0;
        SPECTRAL_KEYWORDS.forEach(kw => {
            if (textContext.includes(kw)) hits++;
        });

        // Dimensions filter
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;

        if (w < 150 || h < 100) return 0; // Filter out tiny icons & logos

        const aspectRatio = w / (h || 1);
        const isGraphAspect = aspectRatio >= 0.8 && aspectRatio <= 3.0; // Typical spectrum graph ratios

        let score = Math.min(100, hits * 25);
        if (isGraphAspect) score += 20;
        return score;
    }

    // Imageye Deep DOM Scanner: Finds all images on current page
    function scanPageImages() {
        const found = [];
        const imgs = document.querySelectorAll('img, [style*="background-image"], picture source');

        imgs.forEach(el => {
            let src = '';
            let alt = el.alt || el.title || 'Page Image';

            if (el.tagName === 'IMG') {
                src = el.currentSrc || el.src || el.getAttribute('data-src') || '';
            } else if (el.style && el.style.backgroundImage) {
                const match = el.style.backgroundImage.match(/url\(['"]?(.*?)['"]?\)/);
                if (match) src = match[1];
            } else if (el.tagName === 'SOURCE') {
                src = el.srcset ? el.srcset.split(' ')[0] : '';
            }

            if (!src || src.startsWith('data:image/svg')) return;

            const score = scoreImageRelevance(el);
            found.push({
                url: src,
                thumbnail: src,
                title: alt,
                width: el.naturalWidth || el.width || 400,
                height: el.naturalHeight || el.height || 300,
                score
            });
        });

        return found;
    }

    // Auto-Select Spectra using Imageye Relevance Score
    function runImageyeAutoExtract() {
        const candidates = scanPageImages();
        const relevant = candidates.filter(c => c.score >= 25);

        relevant.forEach(item => {
            selectedImages.set(item.url, item);
        });

        document.querySelectorAll('img').forEach(img => {
            if (selectedImages.has(img.src)) {
                img.classList.add('spectral-selected-img');
            }
        });

        updateUI();
        alert(`👁️ Imageye Extractor: Automatically selected ${relevant.length} relevant spectrum graph(s) on this page!`);
    }

    autoBtn.addEventListener('click', runImageyeAutoExtract);

    sendBtn.addEventListener('click', async () => {
        const imagesList = Array.from(selectedImages.values());
        if (imagesList.length === 0) return alert('Please select or auto-extract spectrum graph images first!');

        sendBtn.disabled = true;
        sendBtn.textContent = '⏳ Sending to Spectral AI App...';

        try {
            const response = await fetch('http://localhost:3000/api/extension-import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ images: imagesList })
            });

            const data = await response.json();
            if (data.success) {
                alert(`✅ Imageye Extractor: Successfully sent ${imagesList.length} spectrum graph(s) to Spectral AI System! Check dataset queue in app.`);
                selectedImages.clear();
                updateUI();
                document.querySelectorAll('.spectral-selected-img').forEach(el => el.classList.remove('spectral-selected-img'));
            } else {
                throw new Error(data.error || 'Failed to send');
            }
        } catch (err) {
            alert(`❌ Connection Error (http://localhost:3000): ${err.message}. Make sure server is running!`);
        } finally {
            sendBtn.disabled = false;
            sendBtn.textContent = '🚀 Send to Spectral AI App';
        }
    });

    function updateUI() {
        const count = selectedImages.size;
        countBadge.textContent = `${count} selected`;
        sendBtn.disabled = count === 0;
    }

    // Click handler for manual toggle selection on any web image
    function bindImageThumbnails() {
        const imgElements = document.querySelectorAll('img[src^="http"], img[src^="data:"]');
        imgElements.forEach(img => {
            if (img.dataset.spectralBound) return;
            img.dataset.spectralBound = "true";

            img.addEventListener('click', (e) => {
                if (img.width < 100 || img.height < 80) return;

                const parentLink = img.closest('a') || img.parentElement;
                const title = img.alt || parentLink?.getAttribute('aria-label') || 'Spectrum Image';
                const src = img.currentSrc || img.src;

                if (selectedImages.has(src)) {
                    selectedImages.delete(src);
                    img.classList.remove('spectral-selected-img');
                } else {
                    const score = scoreImageRelevance(img);
                    selectedImages.set(src, { url: src, thumbnail: src, title, score });
                    img.classList.add('spectral-selected-img');
                }

                updateUI();
            });
        });
    }

    // Chrome Extension Message Listener for Popup Interaction
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'SCAN_PAGE_SPECTRA') {
                const items = scanPageImages();
                sendResponse({ success: true, images: items });
            } else if (request.action === 'AUTO_EXTRACT_AND_SEND') {
                runImageyeAutoExtract();
                sendResponse({ success: true, count: selectedImages.size });
            }
            return true;
        });
    }

    setInterval(bindImageThumbnails, 1500);
    bindImageThumbnails();
})();
