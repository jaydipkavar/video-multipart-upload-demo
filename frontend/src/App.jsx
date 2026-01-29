import UploadVideo from "./UploadVideo";

export default function App() {
  return (
    <div className="container">
      <h1>Multipart Upload Demo</h1>
      <p className="muted">
        Upload a video in chunks, then reassemble it on the server.
      </p>
      <div className="card">
        <UploadVideo />
      </div>
    </div>
  );
}
