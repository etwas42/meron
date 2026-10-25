package main

// calendarInvoke forwards one calendar command to the core unchanged, like
// tasksInvoke: the core's method names are the frontend's.
func (a *App) calendarInvoke(command string, payload map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call(command, payload)
}
