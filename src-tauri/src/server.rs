use crate::library::Library;
use crate::model::CaptureRequest;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path as AxumPath, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use std::io::SeekFrom;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;
use tower_http::cors::CorsLayer;
use tower_http::limit::RequestBodyLimitLayer;

const ADDRESS: &str = "127.0.0.1:41673";

pub fn start(library: Arc<Library>) {
    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .thread_name("phoenix-api")
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                eprintln!("Phoenix API runtime failed: {error}");
                return;
            }
        };
        runtime.block_on(async move {
            let cors = CorsLayer::new()
                .allow_origin([
                    HeaderValue::from_static("http://tauri.localhost"),
                    HeaderValue::from_static("https://tauri.localhost"),
                    HeaderValue::from_static("tauri://localhost"),
                ])
                .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION, header::RANGE])
                .expose_headers([
                    header::ACCEPT_RANGES,
                    header::CONTENT_LENGTH,
                    header::CONTENT_RANGE,
                ])
                .allow_methods([Method::GET, Method::POST]);

            let app = Router::new()
                .route("/api/v1/health", get(health))
                .route("/api/v1/capture", post(capture))
                .route("/api/v1/assets/{id}/thumbnail", get(thumbnail))
                .route("/api/v1/assets/{id}/original", get(original))
                .layer(DefaultBodyLimit::max(52 * 1024 * 1024))
                .layer(RequestBodyLimitLayer::new(52 * 1024 * 1024))
                .layer(cors)
                .with_state(library);

            let listener = match tokio::net::TcpListener::bind(ADDRESS).await {
                Ok(listener) => listener,
                Err(error) => {
                    eprintln!("Phoenix API could not bind {ADDRESS}: {error}");
                    return;
                }
            };
            if let Err(error) = axum::serve(listener, app).await {
                eprintln!("Phoenix API stopped: {error}");
            }
        });
    });
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({"status": "ok", "name": "Phoenix Project", "apiVersion": 1}))
}

async fn capture(
    State(library): State<Arc<Library>>,
    Json(request): Json<CaptureRequest>,
) -> Response {
    match library.capture(request).await {
        Ok(asset) => (
            StatusCode::CREATED,
            Json(json!({"status": "success", "data": asset})),
        )
            .into_response(),
        Err(error) if error == "Invalid pairing token" => (
            StatusCode::UNAUTHORIZED,
            Json(json!({"status": "error", "message": error})),
        )
            .into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"status": "error", "message": error})),
        )
            .into_response(),
    }
}

async fn thumbnail(
    State(library): State<Arc<Library>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    serve_media(&library, &id, true, None).await
}

async fn original(
    State(library): State<Arc<Library>>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    serve_media(
        &library,
        &id,
        false,
        headers
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok()),
    )
    .await
}

async fn serve_media(
    library: &Library,
    id: &str,
    thumbnail: bool,
    range: Option<&str>,
) -> Response {
    let path = match library.media_path(id, thumbnail) {
        Ok(Some(path)) => path,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let total = match tokio::fs::metadata(&path).await {
        Ok(metadata) => metadata.len() as usize,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let content_type = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();
    let requested_range = match range {
        Some(value) => match parse_byte_range(value, total) {
            Some(range) => Some(range),
            None => {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                    .header(header::ACCEPT_RANGES, "bytes")
                    .body(Body::empty())
                    .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
            }
        },
        None => None,
    };
    let mut file = match tokio::fs::File::open(&path).await {
        Ok(file) => file,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let (status, body, content_range, content_length) = if let Some((start, end)) = requested_range
    {
        if file.seek(SeekFrom::Start(start as u64)).await.is_err() {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        let length = end - start + 1;
        (
            StatusCode::PARTIAL_CONTENT,
            Body::from_stream(ReaderStream::new(file.take(length as u64))),
            Some(format!("bytes {start}-{end}/{total}")),
            length,
        )
    } else {
        (
            StatusCode::OK,
            Body::from_stream(ReaderStream::new(file)),
            None,
            total,
        )
    };
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, content_length)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(
            header::CACHE_CONTROL,
            "private, max-age=31536000, immutable",
        );
    if let Some(content_range) = content_range {
        response = response.header(header::CONTENT_RANGE, content_range);
    }
    response
        .body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn parse_byte_range(value: &str, total: usize) -> Option<(usize, usize)> {
    let value = value.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (start, end) = value.split_once('-')?;
    if total == 0 {
        return None;
    }
    if start.is_empty() {
        let suffix = end.parse::<usize>().ok()?.min(total);
        return (suffix > 0).then_some((total - suffix, total - 1));
    }
    let start = start.parse::<usize>().ok()?;
    if start >= total {
        return None;
    }
    let end = if end.is_empty() {
        total - 1
    } else {
        end.parse::<usize>().ok()?.min(total - 1)
    };
    (start <= end).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::parse_byte_range;

    #[test]
    fn parses_video_byte_ranges() {
        assert_eq!(parse_byte_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_byte_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_byte_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_byte_range("bytes=1000-", 1000), None);
    }
}
