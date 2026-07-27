document.getElementById('btn-open-google').addEventListener('click', () => {
    chrome.tabs.create({
        url: 'https://www.google.com/search?q=absorbance+spectrum+graph&tbm=isch'
    });
});

document.getElementById('btn-open-pubmed').addEventListener('click', () => {
    chrome.tabs.create({
        url: 'https://pubmed.ncbi.nlm.nih.gov/?term=absorbance+spectrum'
    });
});

document.getElementById('btn-auto-extract-page').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0) return;
        chrome.tabs.sendMessage(tabs[0].id, { action: 'AUTO_EXTRACT_AND_SEND' }, (response) => {
            if (chrome.runtime.lastError) {
                alert('Imageye Extractor: Refresh the active webpage to activate extraction.');
            } else if (response && response.success) {
                alert(`✅ Imageye Extractor: Auto-extracted and queued ${response.count || 0} spectrum image(s)!`);
            }
        });
    });
});
