' Forge Harness launcher — starts the local server hidden, then opens the browser.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
Set env = shell.Environment("PROCESS")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = appDir & "\app"
env("FORGE_DASHBOARD_DIST") = appDir & "\dashboard-dist"

' Start the API (and bundled dashboard on http://127.0.0.1:4789) without a console window.
' If an instance is already running, node exits and we simply open the browser below.
shell.Run qq(appDir & "\runtime\node.exe") & " bundle.cjs", 0, False

WScript.Sleep 1800
shell.Run "http://127.0.0.1:4789", 1, False

Function qq(s)
  qq =  Chr(34) & s & Chr(34)
End Function
