Option Explicit
' Mini-Antigravity Local AI Agent Silent Launcher (Pure ASCII for 100% WSH Compatibility)

Dim fso, ws, workDir, rootDrive, modelsDir
Dim localAppData, cacheDir, srcIcon, dstIcon
Dim ollamaExe, cmdOllama, cmdServer, wmi, colItems, objItem, port11434Open, port8790Open

Set fso = CreateObject("Scripting.FileSystemObject")
Set ws = CreateObject("WScript.Shell")

workDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDrive = fso.GetDriveName(workDir)
If rootDrive = "" Then rootDrive = "D:"

modelsDir = ws.ExpandEnvironmentStrings("%OLLAMA_MODELS%")
If modelsDir = "%OLLAMA_MODELS%" Or modelsDir = "" Then
    modelsDir = rootDrive & "\OllamaModels"
End If
If Not fso.FolderExists(modelsDir) Then
    On Error Resume Next
    fso.CreateFolder modelsDir
    On Error GoTo 0
End If
ws.Environment("PROCESS")("OLLAMA_MODELS") = modelsDir

' 1. Local Icon Cache Protection (Anti-White-Paper Policy)
localAppData = ws.ExpandEnvironmentStrings("%LOCALAPPDATA%")
cacheDir = localAppData & "\AI-Agent-Cache"
If Not fso.FolderExists(cacheDir) Then
    fso.CreateFolder cacheDir
End If
srcIcon = workDir & "\runtime\ai_agent.ico"
dstIcon = cacheDir & "\ai_agent.ico"
If fso.FileExists(srcIcon) Then
    On Error Resume Next
    fso.CopyFile srcIcon, dstIcon, True
    On Error GoTo 0
End If

Function IsPortListening(portNum)
    Dim execObj, outStr
    IsPortListening = False
    On Error Resume Next
    Set execObj = ws.Exec("cmd /c netstat -ano | findstr :" & portNum & " | findstr LISTENING")
    outStr = execObj.StdOut.ReadAll()
    If InStr(outStr, ":" & portNum) > 0 Then
        IsPortListening = True
    End If
    On Error GoTo 0
End Function

' 2. Ensure Ollama Engine is running silently on Port 11434
If Not IsPortListening(11434) Then
    ollamaExe = localAppData & "\Programs\Ollama\ollama.exe"
    If Not fso.FileExists(ollamaExe) Then
        ollamaExe = "C:\Program Files\Ollama\ollama.exe"
    End If
    If fso.FileExists(ollamaExe) Then
        cmdOllama = "cmd /c set ""OLLAMA_MODELS=" & modelsDir & """ && """ & ollamaExe & """ serve"
        ws.Run cmdOllama, 0, False
        WScript.Sleep 1500
    End If
End If

' 3. Ensure Web Dashboard Server is running silently on Port 8790
If Not IsPortListening(8790) Then
    cmdServer = "cmd /c cd /d """ & workDir & """ && set ""OLLAMA_MODELS=" & modelsDir & """ && node ""server\server.js"" > ""logs\server.log"" 2>&1"
    If Not fso.FolderExists(workDir & "\logs") Then
        fso.CreateFolder workDir & "\logs"
    End If
    ws.Run cmdServer, 0, False
    WScript.Sleep 1300
End If

' 4. Launch Browser to Web Cockpit
ws.Run "http://localhost:8790", 1, False
