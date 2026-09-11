const THEME_VARIABLES = [
  "--bg", "--surface", "--surface-strong", "--surface-muted", "--line", "--line-soft",
  "--text", "--text-soft", "--text-faint", "--accent", "--accent-soft", "--accent-ink",
  "--blue", "--shadow", "--theme-effect-color",
];

export const ANIMATED_THEMES = Object.freeze({
  "cyberpunk-synapse": {
    effect: "synapse", bg: "#0a0a0f", surface: "#12101a", strong: "#191523", muted: "#15121e",
    line: "#593080", lineSoft: "#2e1d3d", text: "#b9f8fb", soft: "#70cbd1", faint: "#697b86",
    accent: "#e040fb", accentSoft: "#32133b", accentInk: "#f29bff", effectColor: "#0ff0fc",
  },
  "retrowave-embers": {
    effect: "embers", bg: "#1a1a2e", surface: "#16213e", strong: "#1d2948", muted: "#181f38",
    line: "#533483", lineSoft: "#352751", text: "#f7d7df", soft: "#d68aa0", faint: "#7f7396",
    accent: "#e94560", accentSoft: "#42213a", accentInk: "#ff91a3", effectColor: "#ff9b55",
  },
  "midnight-rain": {
    effect: "rain", bg: "#0d1117", surface: "#161b22", strong: "#1c222b", muted: "#131920",
    line: "#30363d", lineSoft: "#242b33", text: "#e6edf3", soft: "#aab4bf", faint: "#697583",
    accent: "#f85149", accentSoft: "#3a2022", accentInk: "#ff8f89", effectColor: "#ffffff",
  },
  "ocean-constellations": {
    effect: "constellations", bg: "#0b1a2c", surface: "#091422", strong: "#10253b", muted: "#0d2034",
    line: "#1e5074", lineSoft: "#15364e", text: "#d9f5ff", soft: "#86cfe9", faint: "#557d91",
    accent: "#4facfe", accentSoft: "#123a5d", accentInk: "#8ccfff", effectColor: "#64d2ff",
  },
  "terminal-flow": {
    effect: "flow", bg: "#000000", surface: "#071007", strong: "#0a160a", muted: "#050c05",
    line: "#0b4c19", lineSoft: "#082e10", text: "#c8ffd4", soft: "#69d87d", faint: "#33733e",
    accent: "#00ff41", accentSoft: "#073b14", accentInk: "#5dff85", effectColor: "#00ff41",
  },
  "ume-petals": {
    effect: "petals", bg: "#2b1b2e", surface: "#1e1420", strong: "#352239", muted: "#261829",
    line: "#6c4675", lineSoft: "#49304f", text: "#f7e9f4", soft: "#dcb5d4", faint: "#957a9b",
    accent: "#f5a0c0", accentSoft: "#522d43", accentInk: "#ffc5da", effectColor: "#f5a0c0",
  },
  "cute-sparkles": {
    effect: "sparkles", bg: "#fff0f5", surface: "#fff8fa", strong: "#ffffff", muted: "#fce9f0",
    line: "#f0c0d0", lineSoft: "#f5d9e3", text: "#71354b", soft: "#a45b76", faint: "#bd879b",
    accent: "#ff6b9d", accentSoft: "#ffe0eb", accentInk: "#a92e59", effectColor: "#ff8cb8",
  },
});

let activeTheme = null;
let activeCanvas = null;
let animationFrame = 0;
let resizeHandler = null;

export function isAnimatedTheme(theme) {
  return Object.hasOwn(ANIMATED_THEMES, theme);
}

function resetAnimatedTheme() {
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  if (resizeHandler) window.removeEventListener("resize", resizeHandler);
  resizeHandler = null;
  activeCanvas?.remove();
  activeCanvas = null;
  activeTheme = null;
  document.documentElement.classList.remove("animated-theme");
  for (const variable of THEME_VARIABLES) document.documentElement.style.removeProperty(variable);
  document.documentElement.style.removeProperty("color-scheme");
}

function applyPalette(theme) {
  const root = document.documentElement;
  root.style.colorScheme = theme.effect === "sparkles" ? "light" : "dark";
  const values = {
    "--bg": theme.bg,
    "--surface": theme.surface,
    "--surface-strong": theme.strong,
    "--surface-muted": theme.muted,
    "--line": theme.line,
    "--line-soft": theme.lineSoft,
    "--text": theme.text,
    "--text-soft": theme.soft,
    "--text-faint": theme.faint,
    "--accent": theme.accent,
    "--accent-soft": theme.accentSoft,
    "--accent-ink": theme.accentInk,
    "--blue": theme.effectColor,
    "--shadow": "0 18px 48px rgba(0,0,0,.42)",
    "--theme-effect-color": theme.effectColor,
  };
  for (const [name, value] of Object.entries(values)) root.style.setProperty(name, value);
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function buildParticles(effect, width, height) {
  if (effect === "rain") return Array.from({ length: 95 }, () => ({
    x: Math.random() * width, y: Math.random() * height, length: randomBetween(18, 62), speed: randomBetween(3, 9), alpha: randomBetween(.12, .38),
  }));
  if (effect === "synapse") return Array.from({ length: 22 }, () => ({
    horizontal: Math.random() > .5, lane: 0, position: Math.random(), speed: randomBetween(.0012, .0048),
  }));
  if (effect === "constellations") return Array.from({ length: 68 }, () => ({
    x: Math.random() * width, y: Math.random() * height, vx: randomBetween(-.16, .16), vy: randomBetween(-.16, .16), radius: randomBetween(1, 2.3), phase: Math.random() * Math.PI * 2,
  }));
  if (effect === "flow") return Array.from({ length: 230 }, () => ({
    x: Math.random() * width, y: Math.random() * height, previousX: null, previousY: null, age: Math.random(), speed: randomBetween(.75, 1.8),
  }));
  if (effect === "petals") return Array.from({ length: 34 }, () => ({
    x: Math.random() * width, y: Math.random() * height, size: randomBetween(3, 8), speed: randomBetween(.22, .7), sway: Math.random() * Math.PI * 2, rotation: Math.random() * Math.PI,
  }));
  if (effect === "sparkles") return Array.from({ length: 62 }, () => ({
    x: Math.random() * width, y: Math.random() * height, size: randomBetween(3, 9), phase: Math.random() * Math.PI * 2, speed: randomBetween(.018, .05),
  }));
  return Array.from({ length: 92 }, () => ({
    x: Math.random() * width, y: Math.random() * height, radius: randomBetween(.7, 2), speed: randomBetween(.35, 1), drift: Math.random() * Math.PI * 2, pulse: Math.random() * Math.PI * 2,
  }));
}

function drawStar(context, x, y, radius, color, alpha) {
  context.save();
  context.translate(x, y);
  context.fillStyle = color;
  context.globalAlpha = alpha;
  context.beginPath();
  context.moveTo(0, -radius);
  context.quadraticCurveTo(radius * .13, -radius * .13, radius, 0);
  context.quadraticCurveTo(radius * .13, radius * .13, 0, radius);
  context.quadraticCurveTo(-radius * .13, radius * .13, -radius, 0);
  context.quadraticCurveTo(-radius * .13, -radius * .13, 0, -radius);
  context.fill();
  context.restore();
}

function renderEffect(context, effect, particles, width, height, color, elapsed, time) {
  context.clearRect(0, 0, width, height);
  if (effect === "rain") {
    context.lineWidth = 1;
    for (const drop of particles) {
      drop.y += drop.speed * elapsed;
      if (drop.y - drop.length > height) { drop.y = -drop.length; drop.x = Math.random() * width; }
      const gradient = context.createLinearGradient(drop.x, drop.y - drop.length, drop.x, drop.y);
      gradient.addColorStop(0, "transparent");
      gradient.addColorStop(1, color);
      context.strokeStyle = gradient;
      context.globalAlpha = drop.alpha;
      context.beginPath(); context.moveTo(drop.x, drop.y - drop.length); context.lineTo(drop.x, drop.y); context.stroke();
    }
  } else if (effect === "synapse") {
    const grid = 28;
    context.strokeStyle = color;
    context.lineWidth = .6;
    context.globalAlpha = .07;
    for (let x = 0; x <= width; x += grid) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke(); }
    for (let y = 0; y <= height; y += grid) { context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke(); }
    for (const pulse of particles) {
      if (!pulse.lane) pulse.lane = Math.floor(Math.random() * ((pulse.horizontal ? height : width) / grid + 1)) * grid;
      pulse.position += pulse.speed * elapsed;
      if (pulse.position > 1.08) { pulse.position = -.08; pulse.lane = 0; }
      const x = pulse.horizontal ? pulse.position * width : pulse.lane;
      const y = pulse.horizontal ? pulse.lane : pulse.position * height;
      context.shadowColor = color; context.shadowBlur = 9; context.fillStyle = color; context.globalAlpha = .7;
      context.beginPath(); context.arc(x, y, 1.5, 0, Math.PI * 2); context.fill(); context.shadowBlur = 0;
    }
  } else if (effect === "constellations") {
    for (const star of particles) {
      star.x = (star.x + star.vx * elapsed + width) % width;
      star.y = (star.y + star.vy * elapsed + height) % height;
      star.phase += .006 * elapsed;
    }
    context.strokeStyle = color; context.lineWidth = .85;
    for (let index = 0; index < particles.length; index += 1) {
      const star = particles[index];
      for (let otherIndex = index + 1; otherIndex < particles.length; otherIndex += 1) {
        const other = particles[otherIndex];
        const distance = Math.hypot(star.x - other.x, star.y - other.y);
        if (distance < 155) {
          context.globalAlpha = (1 - distance / 155) * (.2 + Math.max(0, Math.sin(star.phase)) * .18);
          context.beginPath(); context.moveTo(star.x, star.y); context.lineTo(other.x, other.y); context.stroke();
        }
      }
      context.shadowColor = color; context.shadowBlur = 5;
      context.fillStyle = color; context.globalAlpha = .48 + Math.max(0, Math.sin(star.phase)) * .42;
      context.beginPath(); context.arc(star.x, star.y, star.radius, 0, Math.PI * 2); context.fill();
      context.shadowBlur = 0;
    }
  } else if (effect === "flow") {
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 1.45;
    context.shadowColor = color;
    context.shadowBlur = 5;
    for (const particle of particles) {
      particle.previousX = particle.x;
      particle.previousY = particle.y;
      const angle = Math.sin(particle.x * .006 + time * .00012) * 2.7 + Math.cos(particle.y * .007 - time * .00008) * 2.2;
      particle.x += Math.cos(angle) * particle.speed * elapsed;
      particle.y += Math.sin(angle) * particle.speed * elapsed;
      particle.age -= .0008 * elapsed;
      if (particle.age <= 0 || particle.x < 0 || particle.x > width || particle.y < 0 || particle.y > height) {
        particle.x = Math.random() * width; particle.y = Math.random() * height;
        particle.previousX = particle.x; particle.previousY = particle.y; particle.age = 1;
      }
      const tailLength = 10 + particle.speed * 8;
      context.globalAlpha = .4 + particle.age * .35;
      context.beginPath();
      context.moveTo(particle.x - Math.cos(angle) * tailLength, particle.y - Math.sin(angle) * tailLength);
      context.lineTo(particle.x, particle.y);
      context.stroke();
      context.globalAlpha = .72;
      context.beginPath(); context.arc(particle.x, particle.y, 1.35, 0, Math.PI * 2); context.fill();
    }
    context.shadowBlur = 0;
  } else if (effect === "petals") {
    context.fillStyle = color;
    for (const petal of particles) {
      petal.y += petal.speed * elapsed; petal.sway += .012 * elapsed; petal.rotation += .008 * elapsed;
      petal.x += Math.sin(petal.sway) * .25 * elapsed;
      if (petal.y > height + 12) { petal.y = -12; petal.x = Math.random() * width; }
      context.save(); context.translate(petal.x, petal.y); context.rotate(petal.rotation); context.globalAlpha = .22;
      context.beginPath(); context.ellipse(0, 0, petal.size, petal.size * .42, 0, 0, Math.PI * 2); context.fill(); context.restore();
    }
  } else if (effect === "sparkles") {
    for (const sparkle of particles) {
      sparkle.phase += sparkle.speed * elapsed;
      const glow = Math.max(0, Math.sin(sparkle.phase));
      if (sparkle.phase > Math.PI * 6) { sparkle.phase = 0; sparkle.x = Math.random() * width; sparkle.y = Math.random() * height; }
      if (glow > .04) {
        context.shadowColor = color; context.shadowBlur = 10;
        drawStar(context, sparkle.x, sparkle.y, sparkle.size * (.45 + glow * .55), color, .15 + glow * .62);
        context.shadowBlur = 0;
      }
    }
  } else {
    for (const ember of particles) {
      ember.y -= ember.speed * elapsed; ember.drift += .018 * elapsed; ember.pulse += .025 * elapsed; ember.x += Math.sin(ember.drift) * .28 * elapsed;
      if (ember.y < -10) { ember.y = height + 10; ember.x = Math.random() * width; }
      const alpha = .3 + (.5 + Math.sin(ember.pulse) * .5) * .45;
      context.shadowColor = color; context.shadowBlur = 12; context.fillStyle = color; context.globalAlpha = alpha;
      context.beginPath(); context.arc(ember.x, ember.y, ember.radius, 0, Math.PI * 2); context.fill(); context.shadowBlur = 0;
    }
  }
  context.globalAlpha = 1;
}

export function applyAnimatedTheme(themeName) {
  if (!isAnimatedTheme(themeName)) {
    if (activeTheme) resetAnimatedTheme();
    return false;
  }
  if (activeTheme === themeName && activeCanvas?.isConnected) return true;
  resetAnimatedTheme();
  const theme = ANIMATED_THEMES[themeName];
  activeTheme = themeName;
  applyPalette(theme);
  document.documentElement.classList.add("animated-theme");

  const canvas = document.createElement("canvas");
  canvas.className = "animated-theme-canvas";
  canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);
  activeCanvas = canvas;
  const context = canvas.getContext("2d");
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  let width = 0;
  let height = 0;
  let particles = [];
  resizeHandler = () => {
    width = window.innerWidth; height = window.innerHeight;
    canvas.width = Math.max(1, Math.round(width * pixelRatio));
    canvas.height = Math.max(1, Math.round(height * pixelRatio));
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    particles = buildParticles(theme.effect, width, height);
  };
  resizeHandler();
  window.addEventListener("resize", resizeHandler);

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  let previousTime = performance.now();
  const animate = (time) => {
    if (activeTheme !== themeName || activeCanvas !== canvas) return;
    const elapsed = Math.min(2.5, Math.max(.2, (time - previousTime) / 16.67));
    previousTime = time;
    renderEffect(context, theme.effect, particles, width, height, theme.effectColor, elapsed, time);
    if (!reduceMotion) animationFrame = requestAnimationFrame(animate);
  };
  animationFrame = requestAnimationFrame(animate);
  return true;
}
