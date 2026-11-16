import os
import re
import shutil
import subprocess
from fastapi import HTTPException

YOUTUBE_ID_RE = re.compile(r"(?:v=|youtu\.be/)([a-zA-Z0-9_-]{11})")


def extract_video_id(url: str) -> str:
    m = YOUTUBE_ID_RE.search(url or "")
    if not m:
        raise HTTPException(status_code=400, detail="Invalid YouTube URL (cannot extract video_id)")
    return m.group(1)


def ensure_tools():
    for tool in ["yt-dlp", "ffmpeg", "ffprobe"]:
        if shutil.which(tool) is None:
            raise HTTPException(status_code=500, detail=f"Missing required binary: {tool}")


def run(cmd):
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT)
        return out.decode("utf-8", errors="replace")
    except subprocess.CalledProcessError as e:
        msg = e.output.decode("utf-8", errors="replace") if e.output else str(e)
        raise HTTPException(status_code=500, detail=msg)


def probe_duration(path: str) -> float:
    try:
        out = subprocess.check_output([
            "ffprobe",
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
        ], stderr=subprocess.STDOUT)
        return float(out.decode("utf-8", errors="replace").strip() or 0)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to probe audio duration: {e}")


def split_audio_chunk(input_path: str, output_path: str, start_sec: float, duration_sec: float):
    """Extract an audio chunk with proper re-encoding to avoid corruption."""
    import sys
    try:
        print(f"DEBUG split_audio_chunk: {input_path} ({start_sec}s - {duration_sec}s) -> {output_path}", 
              file=sys.stderr, flush=True)
        
        # First verify input exists
        if not os.path.exists(input_path):
            print(f"DEBUG: Input path does not exist: {input_path}", file=sys.stderr, flush=True)
            raise HTTPException(status_code=400, detail=f"Input file missing: {input_path}")
        
        # Extract chunk with ffmpeg
        run([
            "ffmpeg", "-y",
            "-ss", f"{float(start_sec):.3f}",
            "-t", f"{float(duration_sec):.3f}",
            "-i", input_path,
            "-vn",
            "-acodec", "libmp3lame",
            "-q:a", "2",
            "-ar", "44100",
            "-ab", "128k",
            "-loglevel", "warning",
            output_path,
        ])
        
        # Wait for file to be written
        import time
        time.sleep(0.1)
        
        # Verify output was created with sufficient size
        if not os.path.exists(output_path):
            print(f"DEBUG: Output file missing after ffmpeg: {output_path}", file=sys.stderr, flush=True)
            raise HTTPException(status_code=500, detail=f"Failed to create output chunk: {output_path}")
        
        size = os.path.getsize(output_path)
        print(f"DEBUG: Output chunk size: {size} bytes", file=sys.stderr, flush=True)
        
        if size < 500:
            print(f"DEBUG: Output file too small: {size} bytes in {output_path}", file=sys.stderr, flush=True)
            raise HTTPException(status_code=500, detail=f"Failed to create output chunk (too small): {output_path}")
        
    except Exception as e:
        print(f"DEBUG: Failed to split chunk from {input_path}: {e}", file=sys.stderr, flush=True)
        # Fallback: try copy mode if re-encoding fails
        try:
            run([
                "ffmpeg", "-y",
                "-ss", f"{float(start_sec):.3f}",
                "-t", f"{float(duration_sec):.3f}",
                "-i", input_path,
                "-vn",
                "-acodec", "copy",
                output_path,
            ])
        except Exception as e2:
            print(f"DEBUG: Fallback copy also failed: {e2}", file=sys.stderr, flush=True)
            raise HTTPException(status_code=500, detail=f"Failed to extract audio chunk: {str(e)}")


def download_audio(url: str, out_dir: str) -> str:
    """
    Download YouTube audio using yt-dlp with multiple client fallback strategies.
    Downloads combined video+audio if needed, then extracts audio.
    Always returns an mp3 file for reliable processing.
    """
    import sys
    os.makedirs(out_dir, exist_ok=True)
    vid = extract_video_id(url)
    
    print(f"DEBUG download_audio: url={url} vid={vid} out_dir={out_dir}", file=sys.stderr, flush=True)
    
    # Try multiple client approaches in order of reliability
    clients = [
        ("android", "bestaudio[ext=m4a]/18"),           # Android client - often works
        ("ios", "bestaudio[ext=m4a]/18"),               # iOS client
        ("tvhtml5", "bestaudio[ext=m4a]/18"),          # TV HTML5 client  
        ("web", "bestaudio[ext=m4a]/18"),              # Web client (fallback)
    ]
    
    final_output = b""
    for client_name, format_str in clients:
        print(f"DEBUG: Trying {client_name} client...", file=sys.stderr, flush=True)
        
        cmd = [
            "yt-dlp",
            "--no-update",
            "--extractor-args", f"youtube:player_client={client_name}",
            "-f", format_str,
            "--ignore-errors",
            "--no-part",
            "-o", f"{out_dir}/%(id)s.%(ext)s",
            url
        ]
        
        try:
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            stdout, _ = process.communicate(timeout=120)
            output = stdout.decode("utf-8", errors="replace")
            
            if process.returncode == 0:
                print(f"DEBUG: {client_name} client succeeded!", file=sys.stderr, flush=True)
                final_output = output
                break
                
        except subprocess.TimeoutExpired:
            print(f"DEBUG: {client_name} timed out", file=sys.stderr, flush=True)
            continue
    
    # If all clients failed, try with default (no special args)
    if not final_output:
        print(f"DEBUG: Trying default client (no special args)...", file=sys.stderr, flush=True)
        
        cmd = [
            "yt-dlp",
            "--no-update",
            "-f", "bestaudio[ext=m4a]/18/bestaudio/best/m4a",
            "--ignore-errors",
            "--no-part",
            "-o", f"{out_dir}/%(id)s.%(ext)s",
            url
        ]
        
        try:
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            stdout, _ = process.communicate(timeout=180)
            final_output = stdout.decode("utf-8", errors="replace")
            print(f"DEBUG: default client completed with returncode={process.returncode}", 
                  file=sys.stderr, flush=True)
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504, detail="yt-dlp timed out after 180s")
    
    if not final_output:
        print(f"DEBUG: All YouTube clients failed", file=sys.stderr, flush=True)
        # No successful download - but let's see what happened
        raise HTTPException(status_code=502, detail="All YouTube client extraction methods failed")

    # Find the downloaded file (could be m4a or mp4)
    video_file = None
    for ext in ["m4a", "mp3", "webm", "opus", "mp4"]:
        candidate = os.path.join(out_dir, f"{vid}.{ext}")
        if os.path.exists(candidate):
            video_file = candidate
            print(f"DEBUG: Found file {candidate}", file=sys.stderr, flush=True)
            break
    
    # If no exact match, search for any file with vid prefix
    if not video_file:
        files_in_dir = []
        for f in sorted(os.listdir(out_dir)):
            full_path = os.path.join(out_dir, f)
            print(f"DEBUG: Checking {full_path}", file=sys.stderr, flush=True)
            if os.path.exists(full_path):
                files_in_dir.append((f, full_path))
                if f.startswith(vid + "."):
                    video_file = full_path
                    print(f"DEBUG: Found video file {video_file}", file=sys.stderr, flush=True)
                    break
        print(f"DEBUG: Files in directory: {files_in_dir}", file=sys.stderr, flush=True)
    
    if not video_file:
        error_msg = final_output[:600]
        raise HTTPException(status_code=502, detail=f"yt-dlp download succeeded but file not found: {error_msg}")

    # Extract audio from the downloaded file to mp3 for reliable processing
    print(f"DEBUG: Extracting audio from {video_file}", file=sys.stderr, flush=True)
    mp3_path = os.path.join(out_dir, f"{vid}.mp3")
    try:
        result = subprocess.run([
            "ffmpeg", "-y",
            "-i", video_file,
            "-vn",
            "-acodec", "libmp3lame",
            "-q:a", "0",
            "-ar", "44100",
            "-ab", "128k",
            mp3_path
        ], capture_output=True, timeout=60)
        
        if result.returncode == 0 and os.path.exists(mp3_path):
            size = os.path.getsize(mp3_path)
            print(f"DEBUG: Audio extracted successfully, size={size} bytes", file=sys.stderr, flush=True)
            return mp3_path
        
        # Try copy mode if re-encode failed
        result = subprocess.run([
            "ffmpeg", "-y",
            "-i", video_file,
            "-vn",
            "-acodec", "copy",
            "-f", "mp3",
            mp3_path
        ], capture_output=True, timeout=60)
        
        if result.returncode == 0 and os.path.exists(mp3_path):
            print(f"DEBUG: Audio copied successfully (no re-encode)", file=sys.stderr, flush=True)
            return mp3_path
        
    except Exception as e:
        print(f"DEBUG: Audio extraction failed from {video_file}: {e}", file=sys.stderr, flush=True)
    
    # Return the original file if extraction failed
    print(f"DEBUG: Returning original file {video_file} (extraction failed)", file=sys.stderr, flush=True)
    return video_file
