export default function App(): React.ReactElement {
  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <div className="flex h-10 items-center px-4 drag-region" />
      <main className="flex flex-1 items-center justify-center">
        <p className="text-neutral-500 text-sm">Drop a video to get started</p>
      </main>
    </div>
  )
}
