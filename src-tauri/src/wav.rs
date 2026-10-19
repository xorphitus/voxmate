//! Joining the WAV files VOICEVOX returns, for exporting a whole scene.
//!
//! Only what the engine produces is supported: uncompressed PCM. Every part
//! must have the same format (sampling rate, channels, bit depth); the
//! engine's `outputSamplingRate` decides the rate, so lines made with
//! different settings can't be joined.

#[derive(Debug, PartialEq, thiserror::Error)]
pub enum Error {
    #[error("not a WAV file")]
    NotWav,
    #[error("WAV part {0} has a different format (sampling rate, channels or bit depth) than the first")]
    FormatMismatch(usize),
    #[error("nothing to join")]
    Empty,
}

/// The `fmt ` chunk body and the `data` chunk body of one WAV file.
struct Parts<'a> {
    fmt: &'a [u8],
    data: &'a [u8],
}

fn parse(wav: &[u8]) -> Result<Parts<'_>, Error> {
    if wav.len() < 12 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return Err(Error::NotWav);
    }
    let (mut fmt, mut data) = (None, None);
    let mut at = 12;
    while at + 8 <= wav.len() {
        let id = &wav[at..at + 4];
        let size = u32::from_le_bytes(wav[at + 4..at + 8].try_into().unwrap()) as usize;
        let body = wav.get(at + 8..at + 8 + size).ok_or(Error::NotWav)?;
        match id {
            b"fmt " => fmt = Some(body),
            b"data" => data = Some(body),
            _ => {}
        }
        // Chunks are padded to an even size.
        at += 8 + size + (size & 1);
    }
    Ok(Parts {
        fmt: fmt.ok_or(Error::NotWav)?,
        data: data.ok_or(Error::NotWav)?,
    })
}

/// One WAV with the audio of `parts` back to back, and `gap_seconds` of
/// silence between consecutive parts.
pub fn join(parts: &[Vec<u8>], gap_seconds: f64) -> Result<Vec<u8>, Error> {
    let parsed = parts.iter().map(|p| parse(p)).collect::<Result<Vec<_>, _>>()?;
    let first = parsed.first().ok_or(Error::Empty)?;
    if let Some(i) = parsed.iter().position(|p| p.fmt != first.fmt) {
        return Err(Error::FormatMismatch(i));
    }
    // fmt: format(2) channels(2) rate(4) byte rate(4) block align(2) bits(2)
    let rate = first
        .fmt
        .get(4..8)
        .map_or(0, |b| u32::from_le_bytes(b.try_into().unwrap()));
    let block_align = first
        .fmt
        .get(12..14)
        .map_or(1, |b| u16::from_le_bytes(b.try_into().unwrap()))
        .max(1);
    let gap_bytes = (gap_seconds.max(0.0) * rate as f64).round() as usize * block_align as usize;

    let mut data = Vec::new();
    for (i, p) in parsed.iter().enumerate() {
        if i > 0 {
            data.resize(data.len() + gap_bytes, 0);
        }
        data.extend_from_slice(p.data);
    }

    let mut out = Vec::with_capacity(44 + data.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((4 + 8 + first.fmt.len() + 8 + data.len()) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&(first.fmt.len() as u32).to_le_bytes());
    out.extend_from_slice(first.fmt);
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&data);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 16-bit mono PCM at `rate` with the given samples.
    fn wav(rate: u32, samples: &[i16]) -> Vec<u8> {
        let mut fmt = Vec::new();
        fmt.extend_from_slice(&1u16.to_le_bytes()); // PCM
        fmt.extend_from_slice(&1u16.to_le_bytes()); // mono
        fmt.extend_from_slice(&rate.to_le_bytes());
        fmt.extend_from_slice(&(rate * 2).to_le_bytes());
        fmt.extend_from_slice(&2u16.to_le_bytes());
        fmt.extend_from_slice(&16u16.to_le_bytes());
        let data: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&((4 + 8 + fmt.len() + 8 + data.len()) as u32).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        // An extra chunk before fmt, as some writers add.
        out.extend_from_slice(b"LIST");
        out.extend_from_slice(&3u32.to_le_bytes());
        out.extend_from_slice(&[1, 2, 3, 0]);
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&(fmt.len() as u32).to_le_bytes());
        out.extend_from_slice(&fmt);
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&data);
        out
    }

    #[test]
    fn joins_with_silence_between() {
        let joined = join(&[wav(10, &[1, 2]), wav(10, &[3])], 0.2).unwrap();
        let parts = parse(&joined).unwrap();
        let samples: Vec<i16> = parts.data.chunks(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
        assert_eq!(samples, vec![1, 2, 0, 0, 3]);
        assert_eq!(parts.fmt, parse(&wav(10, &[])).unwrap().fmt);
        let riff_size = u32::from_le_bytes(joined[4..8].try_into().unwrap()) as usize;
        assert_eq!(riff_size, joined.len() - 8);
    }

    #[test]
    fn rejects_mixed_formats_and_garbage() {
        assert_eq!(
            join(&[wav(10, &[1]), wav(20, &[1])], 0.0),
            Err(Error::FormatMismatch(1))
        );
        assert_eq!(join(&[b"nope".to_vec()], 0.0), Err(Error::NotWav));
        assert_eq!(join(&[], 0.0), Err(Error::Empty));
    }
}
