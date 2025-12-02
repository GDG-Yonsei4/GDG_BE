# API 엔드포인트 설정
$url = "http://localhost:3000/api/planning"

# 테스트할 로컬 폴더 경로 (절대 경로)
# 현재 스크립트가 있는 위치의 test-content 폴더를 가리킵니다.
$currentDir = Get-Location
$sourcePath = Join-Path $currentDir "nlp"
$subject = "NLP"

Write-Host "Testing Planning API with sourcePath: $sourcePath"

# 요청 바디 생성
$body = @{
    id = "test-user"
    subjects = @($subject) # sourcePath가 있으면 이 값은 결과의 키로만 사용됨
    structured = $true
    sourcePath = $sourcePath
} | ConvertTo-Json

# API 호출
try {
    $response = Invoke-RestMethod -Method Post -Uri $url -Body $body -ContentType "application/json"
    
    # 결과 출력
    Write-Host "`n--- API Response ---" -ForegroundColor Green
    # JSON을 보기 좋게 출력
    $response | ConvertTo-Json -Depth 10 | Write-Host
    
    Write-Host "`n--- Saved File Path ---" -ForegroundColor Cyan
    Write-Host $response.savedPath
}
catch {
    Write-Host "Error calling API:" -ForegroundColor Red
    Write-Host $_.Exception.Message
    Write-Host $_.ErrorDetails.Message
}