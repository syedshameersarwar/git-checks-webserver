# Github Checks Webserver(GCB core)

A web-server to create checks on pull request with customized status

### Adding branch to installed repo

- Goto line 35 of src/Repo.ts and add else if clause

`else if (repo === "<some-repo>") repoObj[full_name] = "<target-branch>";`

### Deployment

- Build Docker image

`docker build -t gcr.io/<project-id>/github-status-server:latest .`

- Push to container registery

`docker push gcr.io/<project-id>/github-status-server:latest`

- Get Kubernetes cluster credentials

`gcloud container clusters get-credentials <cluster-name> --region <region>`

##### Redis Master

- Create Redis master deployment

`kubectl create -f redis-master-deployment.yaml`

- Create Redis master service

`kubectl create -f redis-master-service.yaml`

##### Redis Slave

- Create Redis slave deployment

`kubectl create -f redis-slave-deployment.yaml`

- Create Redis slave service

`kubectl create -f redis-slave-service.yaml`

##### Web server

- Create Web server deployment

`kubectl create -f server-deployment.yaml`

- Create Web server service

`kubectl create -f server-service.yaml`
