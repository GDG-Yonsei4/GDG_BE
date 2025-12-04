# Node.js 18 버전 (가벼운 Alpine 버전)
FROM node:18-alpine

# 작업 폴더 설정
WORKDIR /usr/src/app

# 의존성 설치
COPY package*.json ./
RUN npm install --production

# 소스 코드 복사
COPY . .

# 포트 설정 (Cloud Run은 기본적으로 8080 포트를 씁니다)
ENV PORT=8080
EXPOSE 8080

# 실행 명령어
CMD [ "node", "src/index.js" ]
# 또는 CMD [ "npm", "run", "start" ]