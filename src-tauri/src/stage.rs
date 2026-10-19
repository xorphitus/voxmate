//! What the Local API knows about playback. The webview performs lines and
//! reports their lifecycle back (`stage_event` command); this keeps recent
//! scene state for `GET /scenes/{id}` and fans events out to `GET /events`.
//!
//! The event types mirror `LineEvent` (src/stage/Line.ts) and `LogEntry`
//! (src/stage/ConversationLog.ts) as sent by src/speech/LocalApiSource.ts.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use utoipa::ToSchema;

/// How many scenes `GET /scenes/{id}` remembers.
pub const MAX_SCENES: usize = 100;
/// Events a slow `/events` subscriber may fall behind by before it misses some.
const EVENT_BUFFER: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum LineState {
    /// Accepted, waiting for its turn.
    Queued,
    /// Being synthesized (may overlap the previous line).
    Preparing,
    /// Playing.
    Speaking,
    /// Played to the end (a stage direction goes straight here).
    Done,
    /// Stopped while speaking.
    Interrupted,
    /// Dropped before it was spoken.
    Skipped,
    /// Synthesis or playback failed; see `error`.
    Failed,
}

impl LineState {
    pub fn is_final(self) -> bool {
        matches!(self, Self::Done | Self::Interrupted | Self::Skipped | Self::Failed)
    }
}

/// A line changed state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LineEvent {
    pub line_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene_id: Option<String>,
    pub character: String,
    pub text: String,
    /// Producer: `api`, `ui`, `llm`, ...
    pub source: String,
    pub state: LineState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A line was heard and added to the conversation log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub line_id: String,
    pub character: String,
    pub text: String,
    pub source: String,
    /// Milliseconds since the Unix epoch, when the line ended.
    pub time: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene_id: Option<String>,
    /// Stopped partway; listeners may not have heard all of `text`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub interrupted: bool,
    /// A stage direction (logged, never spoken).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub direction: bool,
    /// Typed by the user (e.g. a question to a character), not performed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub user: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum StageEvent {
    Line(LineEvent),
    Log(LogEntry),
}

#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LineStatus {
    pub id: String,
    /// Known once the app has queued the line (it fills in the character on stage).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character: Option<String>,
    pub text: String,
    pub state: LineState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SceneStatus {
    pub id: String,
    /// Every line has reached a final state.
    pub finished: bool,
    pub lines: Vec<LineStatus>,
}

pub struct StageTracker {
    scenes: Mutex<VecDeque<SceneStatus>>,
    events: broadcast::Sender<StageEvent>,
}

impl Default for StageTracker {
    fn default() -> Self {
        Self {
            scenes: Mutex::new(VecDeque::new()),
            events: broadcast::channel(EVENT_BUFFER).0,
        }
    }
}

impl StageTracker {
    /// Remembers a submitted scene, forgetting the oldest beyond `MAX_SCENES`.
    pub fn add_scene(&self, scene: SceneStatus) {
        let mut scenes = self.scenes.lock().unwrap();
        scenes.push_back(scene);
        while scenes.len() > MAX_SCENES {
            scenes.pop_front();
        }
    }

    pub fn scene(&self, id: &str) -> Option<SceneStatus> {
        self.scenes.lock().unwrap().iter().find(|s| s.id == id).cloned()
    }

    /// Applies an event from the webview and forwards it to subscribers.
    pub fn record(&self, event: StageEvent) {
        if let StageEvent::Line(e) = &event {
            if let Some(scene_id) = &e.scene_id {
                let mut scenes = self.scenes.lock().unwrap();
                if let Some(scene) = scenes.iter_mut().find(|s| &s.id == scene_id) {
                    if let Some(line) = scene.lines.iter_mut().find(|l| l.id == e.line_id) {
                        line.character = Some(e.character.clone());
                        line.state = e.state;
                        line.error = e.error.clone();
                    }
                    scene.finished = scene.lines.iter().all(|l| l.state.is_final());
                }
            }
        }
        // No subscribers is fine.
        let _ = self.events.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<StageEvent> {
        self.events.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line_event(line_id: &str, scene_id: Option<&str>, state: LineState) -> StageEvent {
        StageEvent::Line(LineEvent {
            line_id: line_id.into(),
            scene_id: scene_id.map(Into::into),
            character: "zunda".into(),
            text: "hi".into(),
            source: "api".into(),
            state,
            error: None,
        })
    }

    fn scene(id: &str, line_ids: &[&str]) -> SceneStatus {
        SceneStatus {
            id: id.into(),
            finished: false,
            lines: line_ids
                .iter()
                .map(|l| LineStatus {
                    id: (*l).into(),
                    character: None,
                    text: "hi".into(),
                    state: LineState::Queued,
                    error: None,
                })
                .collect(),
        }
    }

    #[test]
    fn tracks_line_states_until_the_scene_finishes() {
        let tracker = StageTracker::default();
        tracker.add_scene(scene("s", &["a", "b"]));
        tracker.record(line_event("a", Some("s"), LineState::Done));
        let status = tracker.scene("s").unwrap();
        assert_eq!(status.lines[0].state, LineState::Done);
        assert_eq!(status.lines[0].character.as_deref(), Some("zunda"));
        assert!(!status.finished);
        tracker.record(line_event("b", Some("s"), LineState::Skipped));
        assert!(tracker.scene("s").unwrap().finished);
    }

    #[test]
    fn forgets_the_oldest_scenes() {
        let tracker = StageTracker::default();
        for i in 0..=MAX_SCENES {
            tracker.add_scene(scene(&i.to_string(), &[]));
        }
        assert!(tracker.scene("0").is_none());
        assert!(tracker.scene(&MAX_SCENES.to_string()).is_some());
    }

    #[test]
    fn broadcasts_every_event() {
        let tracker = StageTracker::default();
        let mut rx = tracker.subscribe();
        let event = line_event("x", None, LineState::Speaking);
        tracker.record(event.clone());
        assert_eq!(rx.try_recv().unwrap(), event);
    }

    #[test]
    fn parses_webview_events() {
        let event: StageEvent = serde_json::from_value(serde_json::json!({
            "type": "log", "lineId": "a", "character": "zunda", "text": "hi",
            "source": "ui", "time": 1.5e12, "interrupted": true
        }))
        .unwrap();
        assert!(matches!(
            event,
            StageEvent::Log(LogEntry {
                interrupted: true,
                direction: false,
                ..
            })
        ));
    }
}
