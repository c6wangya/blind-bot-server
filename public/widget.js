(function() {
    // Support multiple injection methods:
    // 1. Direct footer: <script src="...widget.js" data-api-key="xxx">
    // 2. GTM/dynamic: window.BLINDBOT_API_KEY = "xxx" before loading script
    // 3. GTM via script src query param: widget.js?key=xxx

    // Debug: find all script tags
    const allScripts = document.querySelectorAll('script');
    console.log("BlindBot Debug: All scripts:", allScripts.length);
    allScripts.forEach((s, i) => {
        if (s.src && s.src.includes('widget')) console.log(`  [${i}] src:`, s.src);
        if (s.getAttribute('data-gtmsrc')) console.log(`  [${i}] data-gtmsrc:`, s.getAttribute('data-gtmsrc'));
    });

    const scriptTag = document.currentScript
        || document.querySelector('script[data-api-key]')
        || document.querySelector('script[data-gtmsrc*="widget.js"]');

    console.log("BlindBot Debug: scriptTag found:", scriptTag);
    if (scriptTag) {
        console.log("BlindBot Debug: scriptTag.src:", scriptTag.src);
        console.log("BlindBot Debug: data-gtmsrc:", scriptTag.getAttribute('data-gtmsrc'));
    }

    // Extract API key from script src or GTM's data-gtmsrc attribute
    function getKeyFromSrc() {
        if (!scriptTag) return null;
        const srcUrl = scriptTag.src || scriptTag.getAttribute('data-gtmsrc');
        console.log("BlindBot Debug: srcUrl for key extraction:", srcUrl);
        if (!srcUrl) return null;
        try {
            const url = new URL(srcUrl);
            const key = url.searchParams.get('key');
            console.log("BlindBot Debug: extracted key:", key);
            return key;
        } catch (e) {
            console.log("BlindBot Debug: URL parse error:", e);
            return null;
        }
    }

    const apiKey = window.BLINDBOT_API_KEY
        || (scriptTag && scriptTag.getAttribute('data-api-key'))
        || getKeyFromSrc();

    console.log("BlindBot Debug: final apiKey:", apiKey);

    // Server URL: global override or derive from script src
    const SERVER_URL = window.BLINDBOT_API_BASE
        || (scriptTag && scriptTag.src ? new URL(scriptTag.src).origin : 'https://blind-bot-server.onrender.com');

    if (!apiKey) return console.error("BlindBot: No API Key found. Set window.BLINDBOT_API_KEY or use data-api-key attribute.");

    // Fetch Client Config from Server
    fetch(`${SERVER_URL}/client-config/${apiKey}`)
        .then(response => response.json())
        .then(config => {
            initBot(config);
        })
        .catch(err => {
            console.error("BlindBot: Could not load config", err);
            // Fallback
            initBot({ color: "#333", alignment: 'right', sideMargin: 20, bottomMargin: 20, height: 520 });
        });

    function initBot(config) {
        // Defaults if missing
        const isMobile = window.innerWidth <= 768;
        const align = config.alignment || 'right';
        const sideGap = config.sideMargin ?? 20;
        const bottomGap = config.bottomMargin ?? (isMobile ? 100 : 20);
        const chatHeight = config.height ?? 520;

        // 1. Create Container
        const container = document.createElement('div');
        container.id = 'blind-bot-container';
        container.style.position = 'fixed';
        container.style.bottom = `${bottomGap}px`;
        container.style.zIndex = '999999';
        container.style.fontFamily = 'sans-serif';
        
        // DYNAMIC ALIGNMENT
        if (align === 'left') {
            container.style.left = `${sideGap}px`;
            container.style.right = 'auto';
        } else {
            container.style.right = `${sideGap}px`;
            container.style.left = 'auto';
        }

        // 2. Chat Window (Iframe)
        const iframeBox = document.createElement('div');
        iframeBox.style.width = isMobile ? 'calc(100vw - 40px)' : '360px';
        iframeBox.style.height = `${chatHeight}px`; // Dynamic Height
        iframeBox.style.marginBottom = '15px';
        iframeBox.style.borderRadius = '12px';
        iframeBox.style.boxShadow = '0 5px 25px rgba(0,0,0,0.15)';
        iframeBox.style.overflow = 'hidden';
        iframeBox.style.display = 'none';
        iframeBox.style.opacity = '0';
        iframeBox.style.transform = 'translateY(20px)';
        iframeBox.style.transition = 'all 0.3s ease';
        iframeBox.style.backgroundColor = '#fff';

        // Params
        const themeParam = encodeURIComponent(config.color || "#333");
        const logoParam = encodeURIComponent(config.logo || "");
        const nameParam = encodeURIComponent(config.name || "us"); 
        const greetingParam = encodeURIComponent(config.greeting || "");

        const iframe = document.createElement('iframe');
        iframe.src = `${SERVER_URL}/chat.html?apiKey=${apiKey}&theme=${themeParam}&logo=${logoParam}&name=${nameParam}&greeting=${greetingParam}`;
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = 'none';
        iframe.allow = "camera; microphone; fullscreen; clipboard-read; clipboard-write";

        // 3. Floating Bubble
        const bubble = document.createElement('div');
        bubble.style.width = '60px';
        bubble.style.height = '60px';
        bubble.style.borderRadius = '50%';
        bubble.style.backgroundColor = config.color || "#333";
        bubble.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
        bubble.style.cursor = 'pointer';
        bubble.style.display = 'flex';
        bubble.style.alignItems = 'center';
        bubble.style.justifyContent = 'center';
        bubble.style.transition = 'transform 0.2s';
        
        // Float logic for button specifically (to align it within container)
        bubble.style.marginLeft = align === 'left' ? '0' : 'auto';
        bubble.style.marginRight = align === 'right' ? '0' : 'auto';

        // Chat Icon
        const icon = document.createElement('img');
        icon.src = 'https://img.icons8.com/ios-filled/50/ffffff/chat-message.png';
        icon.style.width = '30px';
        icon.style.height = '30px';
        
        // Close Icon
        const closeIcon = document.createElement('span');
        closeIcon.innerHTML = '&times;';
        closeIcon.style.color = 'white';
        closeIcon.style.fontSize = '40px';
        closeIcon.style.lineHeight = '60px';
        closeIcon.style.display = 'none';

        // Assemble
        iframeBox.appendChild(iframe);
        bubble.appendChild(icon);
        bubble.appendChild(closeIcon);
        container.appendChild(iframeBox);
        container.appendChild(bubble);
        document.body.appendChild(container);

        // Toggle Logic
        let isOpen = false;

        function openChat() {
            if (isOpen) return;
            isOpen = true;
            iframeBox.style.display = 'block';
            setTimeout(() => {
                iframeBox.style.opacity = '1';
                iframeBox.style.transform = 'translateY(0)';
            }, 10);
            icon.style.display = 'none';
            closeIcon.style.display = 'block';
        }

        function closeChat() {
            if (!isOpen) return;
            isOpen = false;
            iframeBox.style.opacity = '0';
            iframeBox.style.transform = 'translateY(20px)';
            setTimeout(() => {
                iframeBox.style.display = 'none';
            }, 300);
            icon.style.display = 'block';
            closeIcon.style.display = 'none';
        }

        bubble.addEventListener('mouseenter', openChat);
        bubble.addEventListener('click', () => isOpen ? closeChat() : openChat());
    }
})();