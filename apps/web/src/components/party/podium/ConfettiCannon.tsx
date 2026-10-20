'use client';

import React, { useEffect, useRef } from 'react';

const CONFETTI_COLORS = [
  '#f59e0b', // Gold
  '#6366f1', // Indigo
  '#10b981', // Emerald
  '#f43f5e', // Rose
  '#06b6d4', // Cyan
  '#e2e8f0', // Silver
];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  rotation: number;
  vRot: number;
  tilt: number;
  vTilt: number;
  opacity: number;
}

export function ConfettiCannon() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    // Check prefers-reduced-motion
    if (
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    let width = canvas.width;
    let height = canvas.height;

    const handleResize = () => {
      if (!canvas) return;
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      width = canvas.width;
      height = canvas.height;
    };
    window.addEventListener('resize', handleResize);

    // Initialize 150 particles from bottom corners / center
    const particleCount = 150;
    const particles: Particle[] = [];

    for (let i = 0; i < particleCount; i++) {
      const angle = Math.PI / 4 + Math.random() * (Math.PI / 2); // Upward cone
      const speed = 12 + Math.random() * 18;
      const startX = Math.random() > 0.5 ? width * 0.2 : width * 0.8;

      particles.push({
        x: startX + (Math.random() - 0.5) * 100,
        y: height - 40,
        vx: Math.cos(angle) * speed * (startX < width * 0.5 ? 1 : -1) + (Math.random() - 0.5) * 4,
        vy: -Math.sin(angle) * speed,
        size: 7 + Math.random() * 6,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length] ?? '#f59e0b',
        rotation: Math.random() * 360,
        vRot: (Math.random() - 0.5) * 10,
        tilt: Math.random() * 10,
        vTilt: 0.1 + Math.random() * 0.15,
        opacity: 1,
      });
    }

    let animationFrameId: number;

    const render = () => {
      ctx.clearRect(0, 0, width, height);

      let aliveCount = 0;
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.35; // Gravity
        p.vx *= 0.99; // Drag
        p.rotation += p.vRot;
        p.tilt += p.vTilt;

        if (p.y > height * 0.75) {
          p.opacity -= 0.015;
        }

        if (p.opacity > 0 && p.y < height + 50) {
          aliveCount++;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate((p.rotation * Math.PI) / 180);
          ctx.scale(Math.cos(p.tilt), 1);
          ctx.fillStyle = p.color;
          ctx.globalAlpha = Math.max(0, p.opacity);
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
          ctx.restore();
        }
      }

      if (aliveCount > 0) {
        animationFrameId = requestAnimationFrame(render);
      }
    };

    animationFrameId = requestAnimationFrame(render);

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <canvas ref={canvasRef} className="fixed inset-0 pointer-events-none z-40 w-full h-full" />
  );
}
