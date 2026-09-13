'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getAllUsers } from '@/lib/firebase/firestore';
import { getAllLGAs } from '@/lib/constants';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Plus } from 'lucide-react';
import type { LGA } from '@/types';

export default function AdminMembersPage() {
  const [members, setMembers] = useState<any[]>([]);
  const [lgas, setLgas] = useState<LGA[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetch = async () => {
      const [userData, lgaData] = await Promise.all([
        getAllUsers(),
        getAllLGAs(),
      ]);
      setMembers(userData);
      setLgas(lgaData);
      setLoading(false);
    };
    fetch().catch(() => setLoading(false));
  }, []);

  const getWardName = (user: Record<string, unknown>) => {
    if (user.ward) return String(user.ward);
    if (!user.ward_id || !lgas.length) return String(user.ward_id || '-');
    for (const lga of lgas) {
      const w = lga.wards.find((ward) => ward.id === user.ward_id);
      if (w) return w.name;
    }
    return String(user.ward_id);
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Members</h1>
        <Link
          href="/portal/admin/members/add"
          className="flex items-center space-x-2 bg-apc-primary text-white px-4 py-2 rounded-lg hover:bg-apc-dark transition-colors"
        >
          <Plus className="h-5 w-5" />
          <span>Add Member</span>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Members ({loading ? '...' : members.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p>Loading members...</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b">
                  <tr>
                    <th className="text-left py-3 px-4">Name</th>
                    <th className="text-left py-3 px-4">Email</th>
                    <th className="text-left py-3 px-4">Ward</th>
                    <th className="text-left py-3 px-4">Roles</th>
                    <th className="text-right py-3 px-4">Points</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m: any) => (
                    <tr key={m.id} className="border-b hover:bg-gray-50">
                      <td className="py-3 px-4 font-medium">{m.full_name}</td>
                      <td className="py-3 px-4 text-gray-600">{m.email}</td>
                      <td className="py-3 px-4">{getWardName(m)}</td>
                      <td className="py-3 px-4">
                        {(m.membership_types || []).map((r: string) => (
                          <span key={r} className="inline-block bg-apc-light text-apc-primary text-xs px-2 py-1 rounded mr-1">
                            {r.replace('_', ' ')}
                          </span>
                        ))}
                        {m.access_role && (
                          <span className="inline-block bg-yellow-100 text-yellow-800 text-xs px-2 py-1 rounded mr-1">
                            {m.access_role.replace('_', ' ')}
                          </span>
                        )}
                      </td>
                      <td className="text-right py-3 px-4">{m.points || 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
