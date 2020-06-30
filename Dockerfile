FROM node:12-alpine

WORKDIR /usr/app

RUN apk update && apk upgrade && \
    apk add --no-cache bash git openssh
RUN git config --global user.email "admin@development.com"
RUN git config --global user.name "admin"

COPY package.json .

RUN npm install -g typescript && \
    npm install typescript --save-dev && \
    npm install ts-node --save-dev && \
    npm install

COPY . .

CMD ["npm", "start"]