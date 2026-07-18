/**
 * 陰陽 禅プレイヤー - Yin Yang Zen Player Logic & Animations
 */

document.addEventListener('DOMContentLoaded', () => {
    // ==========================================
    // 1. SAKURA FALLING PETALS ANIMATION (Canvas)
    // ==========================================
    const canvas = document.getElementById('sakura-canvas');
    const ctx = canvas.getContext('2d');

    let width = canvas.width = window.innerWidth;
    let height = canvas.height = window.innerHeight;

    window.addEventListener('resize', () => {
        width = canvas.width = window.innerWidth;
        height = canvas.height = window.innerHeight;
    });

    const petalCount = 40;
    const petals = [];

    // Sakura petal image template or path generator
    class SakuraPetal {
        constructor() {
            this.reset();
            this.y = Math.random() * height; // initial spread
        }

        reset() {
            this.x = Math.random() * width;
            this.y = -20;
            this.size = Math.random() * 8 + 6; // size between 6 and 14
            this.scale = Math.random() * 0.8 + 0.2;
            this.speedY = Math.random() * 1.2 + 0.8; // fall speed
            this.speedX = Math.random() * 1.5 - 0.7; // drift speed
            this.angle = Math.random() * 360;
            this.spinSpeed = Math.random() * 2 - 1;
            this.opacity = Math.random() * 0.4 + 0.5; // opacity 0.5 - 0.9
            this.color = Math.random() > 0.4 ? '#ffb7c5' : '#ffa1b2'; // soft cherry pinks
        }

        update() {
            this.y += this.speedY;
            this.x += this.speedX + Math.sin(this.y / 30) * 0.5; // gentle swaying
            this.angle += this.spinSpeed;

            // Reset when petal reaches bottom or sides
            if (this.y > height + 20 || this.x < -20 || this.x > width + 20) {
                this.reset();
            }
        }

        draw() {
            ctx.save();
            ctx.translate(this.x, this.y);
            ctx.rotate(this.angle * Math.PI / 180);
            ctx.scale(this.scale, this.scale);
            
            ctx.beginPath();
            ctx.fillStyle = this.color;
            ctx.globalAlpha = this.opacity;
            
            // Draw beautiful natural petal shape using Bezier curves
            ctx.moveTo(0, 0);
            ctx.bezierCurveTo(-this.size, -this.size / 2, -this.size, this.size, 0, this.size * 1.5);
            ctx.bezierCurveTo(this.size, this.size, this.size, -this.size / 2, 0, 0);
            ctx.fill();
            
            // Petal crease highlight
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
            ctx.lineWidth = 0.8;
            ctx.moveTo(0, 0);
            ctx.lineTo(0, this.size * 1.1);
            ctx.stroke();
            
            ctx.restore();
        }
    }

    // Initialize petals
    for (let i = 0; i < petalCount; i++) {
        petals.push(new SakuraPetal());
    }

    // Animation Loop
    function animateSakura() {
        ctx.clearRect(0, 0, width, height);
        petals.forEach(petal => {
            petal.update();
            petal.draw();
        });
        requestAnimationFrame(animateSakura);
    }
    animateSakura();


    // ==========================================
    // 2. AUDIO PLAYER LOGIC
    // ==========================================
    const playlist = [
        {
            title: "桜の舞 (Sakura Dance)",
            artist: "Traditional Shakuhachi & Lofi Beat",
            src: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"
        },
        {
            title: "竹林の風 (Bamboo Forest Wind)",
            artist: "Elegant Koto Lofi Chillout",
            src: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3"
        },
        {
            title: "侍の魂 (Spirit of the Samurai)",
            artist: "Ancient Shamisen Ambient Groove",
            src: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3"
        },
        {
            title: "夜の雨 (Midnight Zen Rain)",
            artist: "Soothing Flute & Rain Soundscape",
            src: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3"
        }
    ];

    let currentTrackIdx = 0;
    let isPlaying = false;

    // DOM Elements
    const audio = document.getElementById('audio-player');
    const playPauseBtn = document.getElementById('play-pause');
    const playIcon = document.getElementById('play-icon');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    
    const trackTitle = document.getElementById('track-title');
    const trackArtist = document.getElementById('track-artist');
    const vinyl = document.getElementById('vinyl');

    const currentTimeEl = document.getElementById('current-time');
    const durationEl = document.getElementById('duration');
    
    const progressContainer = document.getElementById('progress-container');
    const progressBar = document.getElementById('progress-bar');
    const progressKnob = document.getElementById('progress-knob');

    const volumeWrapper = document.getElementById('volume-wrapper');
    const volumeBar = document.getElementById('volume-bar');
    const volumeKnob = document.getElementById('volume-knob');

    const playlistToggle = document.getElementById('playlist-toggle');
    const playlistDrawer = document.getElementById('playlist-drawer');
    const drawerClose = document.getElementById('drawer-close');
    const playlistItemsContainer = document.getElementById('playlist-items');

    // Populate Playlist UI
    function renderPlaylist() {
        playlistItemsContainer.innerHTML = '';
        playlist.forEach((track, index) => {
            const li = document.createElement('li');
            li.className = `playlist-item ${index === currentTrackIdx ? 'active' : ''}`;
            li.innerHTML = `
                <div class="playlist-item-title">${track.title}</div>
                <div class="playlist-item-artist">${track.artist}</div>
            `;
            li.addEventListener('click', () => {
                selectTrack(index);
                playlistDrawer.classList.remove('open');
            });
            playlistItemsContainer.appendChild(li);
        });
    }

    // Select specific track
    function selectTrack(index) {
        currentTrackIdx = index;
        audio.src = playlist[currentTrackIdx].src;
        trackTitle.textContent = playlist[currentTrackIdx].title;
        trackArtist.textContent = playlist[currentTrackIdx].artist;
        
        // Update playlist active state
        const items = playlistItemsContainer.querySelectorAll('.playlist-item');
        items.forEach((item, idx) => {
            if (idx === index) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });

        if (isPlaying) {
            audio.play().catch(e => console.log("Play failed: ", e));
        } else {
            updateProgressUI(0, 0);
        }
    }

    // Toggle Play / Pause
    function togglePlay() {
        if (isPlaying) {
            pauseTrack();
        } else {
            playTrack();
        }
    }

    function playTrack() {
        isPlaying = true;
        playIcon.innerHTML = '⏸'; // pause symbol
        vinyl.classList.add('playing');
        audio.play().then(() => {
            // Success
        }).catch(err => {
            console.log("Audio autoplay prevented or error: ", err);
            isPlaying = false;
            playIcon.innerHTML = '▶';
            vinyl.classList.remove('playing');
        });
    }

    function pauseTrack() {
        isPlaying = false;
        playIcon.innerHTML = '▶';
        vinyl.classList.remove('playing');
        audio.pause();
    }

    function nextTrack() {
        let nextIdx = currentTrackIdx + 1;
        if (nextIdx >= playlist.length) {
            nextIdx = 0;
        }
        selectTrack(nextIdx);
        if (isPlaying) playTrack();
    }

    function prevTrack() {
        let prevIdx = currentTrackIdx - 1;
        if (prevIdx < 0) {
            prevIdx = playlist.length - 1;
        }
        selectTrack(prevIdx);
        if (isPlaying) playTrack();
    }

    // Format time: seconds to MM:SS
    function formatTime(seconds) {
        if (isNaN(seconds)) return "0:00";
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
    }

    // Update Progress UI
    function updateProgressUI(current, duration) {
        const percent = duration > 0 ? (current / duration) * 100 : 0;
        progressBar.style.width = `${percent}%`;
        progressKnob.style.left = `${percent}%`;
        currentTimeEl.textContent = formatTime(current);
        durationEl.textContent = formatTime(duration);
    }

    // Time update listener
    audio.addEventListener('timeupdate', () => {
        updateProgressUI(audio.currentTime, audio.duration);
    });

    // Handle track ended -> Auto Next
    audio.addEventListener('ended', () => {
        nextTrack();
    });

    // Handle metadata loaded (to set duration initially)
    audio.addEventListener('loadedmetadata', () => {
        updateProgressUI(audio.currentTime, audio.duration);
    });

    // Progress bar scrubbing / clicking
    function setProgress(e) {
        const rect = progressContainer.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const width = rect.width;
        const clickPercent = Math.max(0, Math.min(100, (clickX / width) * 100));
        
        if (audio.duration) {
            audio.currentTime = (clickPercent / 100) * audio.duration;
            updateProgressUI(audio.currentTime, audio.duration);
        }
    }

    // Progress bar drag support
    let isDraggingProgress = false;

    progressContainer.addEventListener('mousedown', (e) => {
        isDraggingProgress = true;
        setProgress(e);
    });

    window.addEventListener('mousemove', (e) => {
        if (isDraggingProgress) {
            setProgress(e);
        }
    });

    window.addEventListener('mouseup', () => {
        isDraggingProgress = false;
    });

    // Touch support for progress
    progressContainer.addEventListener('touchstart', (e) => {
        isDraggingProgress = true;
        setProgress(e.touches[0]);
    });

    window.addEventListener('touchmove', (e) => {
        if (isDraggingProgress) {
            setProgress(e.touches[0]);
        }
    });

    window.addEventListener('touchend', () => {
        isDraggingProgress = false;
    });


    // ==========================================
    // 3. VOLUME CONTROL LOGIC
    // ==========================================
    let currentVolume = 0.8;
    audio.volume = currentVolume;

    function setVolume(e) {
        const rect = volumeWrapper.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const width = rect.width;
        const clickPercent = Math.max(0, Math.min(100, (clickX / width) * 100));

        currentVolume = clickPercent / 100;
        audio.volume = currentVolume;
        
        volumeBar.style.width = `${clickPercent}%`;
        volumeKnob.style.left = `${clickPercent}%`;
    }

    let isDraggingVolume = false;

    volumeWrapper.addEventListener('mousedown', (e) => {
        isDraggingVolume = true;
        setVolume(e);
    });

    window.addEventListener('mousemove', (e) => {
        if (isDraggingVolume) {
            setVolume(e);
        }
    });

    window.addEventListener('mouseup', () => {
        isDraggingVolume = false;
    });

    // Touch support for volume
    volumeWrapper.addEventListener('touchstart', (e) => {
        isDraggingVolume = true;
        setVolume(e.touches[0]);
    });

    window.addEventListener('touchmove', (e) => {
        if (isDraggingVolume) {
            setVolume(e.touches[0]);
        }
    });

    window.addEventListener('touchend', () => {
        isDraggingVolume = false;
    });


    // ==========================================
    // 4. PLAYLIST DRAWER NAVIGATION
    // ==========================================
    playlistToggle.addEventListener('click', () => {
        playlistDrawer.classList.add('open');
    });

    drawerClose.addEventListener('click', () => {
        playlistDrawer.classList.remove('open');
    });

    // Close drawer when clicking outside it, but inside the card
    document.addEventListener('click', (e) => {
        if (!playlistDrawer.contains(e.target) && 
            e.target !== playlistToggle && 
            !playlistToggle.contains(e.target) &&
            playlistDrawer.classList.contains('open')) {
            playlistDrawer.classList.remove('open');
        }
    });


    // ==========================================
    // 5. EVENT BINDING & INITS
    // ==========================================
    playPauseBtn.addEventListener('click', togglePlay);
    nextBtn.addEventListener('click', nextTrack);
    prevBtn.addEventListener('click', prevTrack);

    // Initialize player tracks
    renderPlaylist();
    selectTrack(0);
});
