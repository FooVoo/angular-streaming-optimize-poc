//! Procedural thumbnails.
//!
//! 512 deterministic images generated at boot, referenced by rows through a
//! 2-byte `image_id`. Patterns are flat-shaded on purpose so PNG compresses hard
//! and the sprite atlas stays around a megabyte.

use rayon::prelude::*;
use serde::Serialize;

use crate::rng::Rng;

pub const THUMB: u32 = 64;
pub const THUMB_2X: u32 = 128;
pub const ATLAS_COLS: u32 = 32;

pub struct ImagePool {
    pub png_1x: Vec<Vec<u8>>,
    pub png_2x: Vec<Vec<u8>>,
    pub atlas_png: Vec<u8>,
    pub meta: AtlasMeta,
}

#[derive(Serialize, Clone)]
pub struct AtlasMeta {
    pub count: u32,
    pub cell: u32,
    pub cols: u32,
    pub rows: u32,
    pub width: u32,
    pub height: u32,
    /// Dominant colour per image as `#rrggbb`. The frontend paints it as the cell
    /// background before the bitmap decodes, so scrolling never flashes white.
    pub colors: Vec<String>,
}

fn hsv_to_rgb(h: f64, s: f64, v: f64) -> [u8; 3] {
    let h = h.rem_euclid(360.0);
    let c = v * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = v - c;
    let (r, g, b) = match h as u32 / 60 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    [
        (((r + m) * 255.0).round()) as u8,
        (((g + m) * 255.0).round()) as u8,
        (((b + m) * 255.0).round()) as u8,
    ]
}

/// RGBA pixels for one procedural image. `variant` picks the pattern, the hue
/// walks the colour wheel so neighbouring ids stay visually distinct.
pub fn render(variant: u32, size: u32) -> (Vec<u8>, [u8; 3]) {
    let mut rng = Rng::counter(0xA11CE, variant as u64);
    let hue = (variant as f64 * 137.508) % 360.0; // golden-angle spacing
    let base = hsv_to_rgb(hue, 0.55, 0.85);
    let accent = hsv_to_rgb(hue + 40.0, 0.75, 0.55);
    let dark = hsv_to_rgb(hue + 200.0, 0.45, 0.35);
    let pattern = variant % 5;
    let wobble = rng.below(5) + 3;

    let mut px = vec![0u8; (size * size * 4) as usize];
    let s = size as f64;
    for y in 0..size {
        for x in 0..size {
            let fx = x as f64 / s;
            let fy = y as f64 / s;
            let c = match pattern {
                // concentric rings
                0 => {
                    let d = ((fx - 0.5).powi(2) + (fy - 0.5).powi(2)).sqrt();
                    if ((d * wobble as f64 * 2.0) as u32).is_multiple_of(2) {
                        base
                    } else {
                        accent
                    }
                }
                // diagonal stripes
                1 => {
                    if (((fx + fy) * wobble as f64 * 2.0) as u32).is_multiple_of(2) {
                        base
                    } else {
                        dark
                    }
                }
                // checkerboard
                2 => {
                    let cx = (fx * wobble as f64) as u32;
                    let cy = (fy * wobble as f64) as u32;
                    if (cx + cy).is_multiple_of(2) {
                        base
                    } else {
                        accent
                    }
                }
                // corner wedge
                3 => {
                    if fy > fx {
                        base
                    } else if fy > fx * 0.5 {
                        accent
                    } else {
                        dark
                    }
                }
                // centre block on a field
                _ => {
                    let inside = (0.25..0.75).contains(&fx) && (0.25..0.75).contains(&fy);
                    if inside { accent } else { base }
                }
            };
            let o = ((y * size + x) * 4) as usize;
            px[o] = c[0];
            px[o + 1] = c[1];
            px[o + 2] = c[2];
            px[o + 3] = 255;
        }
    }
    (px, base)
}

fn encode_png(px: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().expect("png header");
        writer.write_image_data(px).expect("png data");
    }
    out
}

/// One PNG for an arbitrary row id — used by `--unique-images`, which defeats the
/// pool's cache-hit behaviour on purpose so the miss path can be measured.
pub fn render_png_for(variant: u32, size: u32) -> Vec<u8> {
    let (px, _) = render(variant, size);
    encode_png(&px, size, size)
}

pub fn build_pool(count: u16) -> ImagePool {
    let count32 = count as u32;
    let rendered: Vec<(Vec<u8>, [u8; 3])> = (0..count32)
        .into_par_iter()
        .map(|i| render(i, THUMB))
        .collect();

    let png_1x: Vec<Vec<u8>> = rendered
        .par_iter()
        .map(|(px, _)| encode_png(px, THUMB, THUMB))
        .collect();
    let png_2x: Vec<Vec<u8>> = (0..count32)
        .into_par_iter()
        .map(|i| {
            let (px, _) = render(i, THUMB_2X);
            encode_png(&px, THUMB_2X, THUMB_2X)
        })
        .collect();

    let cols = ATLAS_COLS;
    let rows = count32.div_ceil(cols);
    let width = cols * THUMB;
    let height = rows * THUMB;
    let mut atlas = vec![0u8; (width * height * 4) as usize];
    for (i, (px, _)) in rendered.iter().enumerate() {
        let i = i as u32;
        let ox = (i % cols) * THUMB;
        let oy = (i / cols) * THUMB;
        for y in 0..THUMB {
            let src = (y * THUMB * 4) as usize;
            let dst = (((oy + y) * width + ox) * 4) as usize;
            atlas[dst..dst + (THUMB * 4) as usize]
                .copy_from_slice(&px[src..src + (THUMB * 4) as usize]);
        }
    }

    let colors = rendered
        .iter()
        .map(|(_, c)| format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2]))
        .collect();

    ImagePool {
        atlas_png: encode_png(&atlas, width, height),
        png_1x,
        png_2x,
        meta: AtlasMeta {
            count: count32,
            cell: THUMB,
            cols,
            rows,
            width,
            height,
            colors,
        },
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Minimal base64 for the data-URI anti-pattern endpoint. Not worth a dependency
/// for the one route whose purpose is to demonstrate that it is a bad idea.
pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_is_deterministic() {
        assert_eq!(render(17, THUMB).0, render(17, THUMB).0);
        assert_ne!(render(17, THUMB).0, render(18, THUMB).0);
    }

    #[test]
    fn png_has_magic_header() {
        let png = render_png_for(3, THUMB);
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    }

    #[test]
    fn pool_shape() {
        let pool = build_pool(64);
        assert_eq!(pool.png_1x.len(), 64);
        assert_eq!(pool.png_2x.len(), 64);
        assert_eq!(pool.meta.colors.len(), 64);
        assert_eq!(pool.meta.rows, 2);
        assert!(!pool.atlas_png.is_empty());
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
