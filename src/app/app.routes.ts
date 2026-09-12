import { Routes } from '@angular/router';
import { AgentsComponent } from './agents/agents.component';
import { ChatComponent } from './chat/chat.component';
import { ProvidersComponent } from './providers/providers.component';
import { EmbeddingsComponent } from './embeddings/embeddings.component';

export const routes: Routes = [
  { path: '', redirectTo: '/chat', pathMatch: 'full' },
  { path: 'chat', component: ChatComponent },
  { path: 'providers', component: ProvidersComponent },
  { path: 'agents', component: AgentsComponent },
  { path: 'embeddings', component: EmbeddingsComponent },
];
