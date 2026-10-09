// Helpers for the 3D view: text labels, and the site geometry from
// src/geometry.js (borings' positions in metres, which borings are neighbours).
import * as THREE from 'three';

export { localPositions, neighbourEdges } from '../src/geometry.js';

export function textSprite(textValue, { size = 28, color = '#111', background = 'rgba(255,255,255,0.85)' } = {}) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = `bold ${size}px Arial, sans-serif`;
    const w = Math.ceil(ctx.measureText(textValue).width) + 16;
    canvas.width = w;
    canvas.height = size + 12;
    ctx.font = `bold ${size}px Arial, sans-serif`;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(textValue, 8, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
    sprite.userData.aspect = canvas.width / canvas.height;
    sprite.renderOrder = 10;
    return sprite;
}
