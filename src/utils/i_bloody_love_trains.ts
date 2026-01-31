import { type StyleSpecification } from 'maplibre-gl';

const train_lw = [ "interpolate", ["linear"], ["zoom"], 0, 1, 18, 1 ];
const train_colour = '#999';

export const give_me_more_trains = (style: StyleSpecification) => {
    style.layers.forEach(layer => {
        if (layer.type === 'line' && (layer.id.includes('rail') || layer.id.includes('train') || layer.id.includes('transportation'))) {
            delete layer.minzoom;
            delete layer.maxzoom;
            if (!layer.paint) {
                layer.paint = {};
            }
            layer.paint['line-width'] = train_lw as any; // typescript is so annoying sometimes
            layer.paint['line-color'] = train_colour;

        }
    });
    const url = new URL(window.location.href);
    const clean_url = url.origin + url.pathname;
    style.sources['low-zoom-rails'] = {
        type: 'vector',
        tiles: [clean_url + 'train_tiles/{z}/{x}/{y}.pbf'],
        minzoom: 0,
        maxzoom: 8,
        attribution: '&copy; <a href="https://www.naturalearthdata.com/about/terms-of-use/">naturalearthdata.com</a>'
    };
    const railLayerIndex = style.layers.findIndex(l => l.id.includes('rail'));
    
    style.layers.splice(railLayerIndex + 1, 0, {
      id: 'global-rails-low-zoom',
      type: 'line',
      source: 'low-zoom-rails',
      'source-layer': 'ne_10m_railroads',
      minzoom: 0,
      maxzoom: 8,
      layout: { 
        'line-join': 'round', 
        'line-cap': 'round' 
      },
      paint: {
        'line-color': train_colour,
        'line-width': train_lw as any,
      }
    });
}
