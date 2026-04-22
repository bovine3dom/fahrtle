import { hsl } from 'd3';
export function getHalo(hex: string): string {
    const colour = hsl(hex);
    colour.l = colour.l > 0.5 ? 0.3 : 0.95;
    colour.s *= 0.5;
    return colour.toString();
}
