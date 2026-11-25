// ============================================================================
// MintPy Desktop Theme & Style Configuration (Single Source for 6 Worlds)
// ============================================================================
(function () {
  'use strict';

  const STYLE_ACCENTS = {
    zen: { accent: '#4ade80', glow: 'rgba(74, 222, 128, 0.25)', icon: '🎋', label: 'Zen (Сад камней)' },
    lofi: { accent: '#f59e0b', glow: 'rgba(245, 158, 11, 0.25)', icon: '☕', label: 'Lo-Fi (Уютный кофе)' },
    synthwave: { accent: '#ec4899', glow: 'rgba(236, 72, 153, 0.25)', icon: '🌆', label: 'Synthwave (Ретро-закат)' },
    ocean: { accent: '#38bdf8', glow: 'rgba(56, 189, 248, 0.25)', icon: '🌊', label: 'Ocean (Морские глубины)' },
    forest: { accent: '#22c55e', glow: 'rgba(34, 197, 94, 0.25)', icon: '🌲', label: 'Forest (Ночной лес)' },
    aurora: { accent: '#a855f7', glow: 'rgba(168, 85, 247, 0.25)', icon: '✨', label: 'Aurora (Северное сияние)' }
  };

  const ZEN_PRESET_ACCENTS = {
    'blue-purple': { accent: '#a5202d', secondary: '#486b45', label: 'Crimson Hanko' },
    'green-teal': { accent: '#3b6a48', secondary: '#7a5c3a', label: 'Matcha' },
    'orange-red': { accent: '#b84a27', secondary: '#4d6b53', label: 'Autumn Maple' },
    'pink-rose': { accent: '#b24b63', secondary: '#556b4d', label: 'Sakura' },
    'cyan-lime': { accent: '#2d5d73', secondary: '#5e7045', label: 'Indigo Mist' },
    'white-cold': { accent: '#4f5663', secondary: '#6b6258', label: 'Sumi Ink' }
  };

  const STYLE_PHRASES = {
    zen: {
      brand: '音の間', title: '静かな音', volume: '音量', queue: '次',
      eyebrow: 'NOW PLAYING · 再生中', empty: '静けさの中に、音がある',
      quote: { text: '古池や<br>蛙飛びこむ<br>水の音', by: '— 松尾芭蕉' },
      playerTag: '朱に交わる',
      miniBadge: 'ZEN HI-FI · 96kHz/24bit',
      mute: ['消音', '音あり'],
      nav: { home: 'ホーム', search: '検索', favorites: 'お気に入り', playlists: '再生リスト', library: '音楽庫', settings: '設定' }
    },
    lofi: {
      brand: 'salon du son', title: 'douceur sonore', volume: 'volume', queue: '→',
      eyebrow: 'NOW PLAYING · en cours', empty: 'Dans le calme, la musique',
      quote: { text: '«La musique est la langue des émotions»', by: '— Voltaire' },
      playerTag: 'cassette nº1',
      miniBadge: 'LO-FI · CASSETTE HI-FI',
      mute: ['silence…', 'le son revient'],
      nav: { home: 'accueil', search: 'chercher', favorites: 'favoris', playlists: 'listes', library: 'bibliothèque', settings: 'réglages' }
    },
    synthwave: {
      brand: 'SONIDO', title: 'noche de neón', volume: 'VOL', queue: '»',
      eyebrow: 'NOW PLAYING · REPRODUCIENDO', empty: 'En la noche, el ritmo',
      quote: { text: 'El silencio es música<br>en pausa', by: '— Retrowave' },
      playerTag: 'FM 84.0 MHz',
      miniBadge: 'SYNTHWAVE · FM 84.0',
      mute: ['SILENCIO', 'SONIDO'],
      nav: { home: 'inicio', search: 'buscar', favorites: 'favoritos', playlists: 'listas', library: 'biblioteca', settings: 'ajustes' }
    },
    aurora: {
      brand: 'lydrommet', title: 'stillhet og lyd', volume: 'lyd', queue: '→',
      eyebrow: 'NOW PLAYING · spiller', empty: 'I stillheten finnes tonene',
      quote: { text: 'Naturen synger<br>sin egen melodi', by: '— Nordlys' },
      playerTag: 'nordlys aktiv',
      miniBadge: 'AURORA · POLAR HI-FI',
      mute: ['hysj…', 'lyden er tilbake'],
      nav: { home: 'hjem', search: 'søk', favorites: 'favoritter', playlists: 'lister', library: 'bibliotek', settings: 'innstillinger' }
    },
    ocean: {
      brand: 'ABYSSAL', title: 'deep sea vibrations', volume: 'depth', queue: '→',
      eyebrow: 'NOW PLAYING · SUBMERGED', empty: 'In the depths, only echoes',
      quote: { text: 'The sea, once it casts its spell,<br>holds one in its net of wonder forever.', by: '— J. Cousteau' },
      playerTag: 'nautilus 01',
      miniBadge: 'OCEAN · SONAR HI-FI',
      mute: ['SILENCE', 'SONAR'],
      nav: { home: 'home', search: 'sonar', favorites: 'pearls', playlists: 'currents', library: 'abyss', settings: 'config' }
    },
    forest: {
      brand: 'äänihuone', title: ' hiljaa soi', volume: 'ääni', queue: '→',
      eyebrow: 'NOW PLAYING · soi', empty: 'Hiljaisuudessa laulaa metsä',
      quote: { text: 'Bambu taipuu,<br>muttei katkea', by: '— Sananlasku' },
      playerTag: 'viidantaival',
      miniBadge: 'FOREST · WOODLAND HI-FI',
      mute: ['hiljaisuus', 'ääni palasi'],
      nav: { home: 'koti', search: 'haku', favorites: 'suosikit', playlists: 'listat', library: 'kirjasto', settings: 'asetukset' }
    }
  };

  window.MintPyThemes = {
    STYLE_ACCENTS,
    ZEN_PRESET_ACCENTS,
    STYLE_PHRASES
  };
})();
